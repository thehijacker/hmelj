import { store } from './store.js';
import { listMessages, getMessage, getAttachment, moveMessages, copyMessages, setFlags, deleteMessages } from './mailClient.js';
import { sendMail } from './smtpClient.js';
import { currentUser } from './session.js';
// cache.js is safe to import here; sync.js is not (it imports this module), which
// is why folder-cache reconciliation is reported back to the caller instead.
import { claimFilterSend, releaseFilterSend, claimFilterApplied, releaseFilterApplied } from './cache.js';
import * as userLog from './userLog.js';
import { log } from './log.js';

const flog = log.scope('filters');

/**
 * Filter shape:
 * { id, name, enabled, match: 'all' | 'any' | 'always', accountId: string | null,
 *   rules: [{ field: subject|from|to|content|size|date, op: contains|notContains|is|greater|less, value }],
 *   actions: [{ type: move|copy|redirect|reply|delete|markRead|markUnread|star, value }] }
 *
 * accountId scopes a filter to one specific mail account; null/empty means
 * "every account" (a copy of the rule runs independently against each
 * account's own inbox). Needed because move/copy actions reference a folder
 * path, and different accounts have different folder trees — a filter tied
 * to one account's folders wouldn't make sense applied against another.
 */

function fieldValue(msg, field) {
  switch (field) {
    case 'subject': return msg.subject || '';
    case 'from': return `${msg.from?.name || ''} ${msg.from?.address || ''}`.trim();
    case 'to': return (msg.to || []).map((t) => `${t.name || ''} ${t.address || ''}`).join(', ');
    case 'size': return msg.size || 0;
    case 'date': return msg.date ? new Date(msg.date) : null;
    default: return '';
  }
}

// ---------------------------------------------------------------------------
// Copies this engine made itself.
//
// A filter that moves a message doesn't make it vanish — it mints a NEW copy,
// under a new uid, in a folder sync.js also polls in its own right. That poll
// sees a uid above the folder's high-water mark, calls it new mail, and runs
// the filters over it a second time. Idempotent actions (move/markRead/star)
// don't care. `redirect` and `reply` very much do: the same message got
// forwarded, or auto-replied to, twice — once on arrival and once again
// seconds later when the destination folder's turn came round in the same
// sync cycle. Rules are supposed to fire once per delivered message.
//
// So: whenever we relocate a message ourselves, write down where we put it.
// sync.js asks before filtering (`claimFiled`), and asking consumes the note,
// so this only ever suppresses the one poll that first sees our copy — a
// genuinely new message that later happens to reuse that uid is untouched.
//
// Deliberately in-memory and best-effort. A restart between the move and the
// destination's next poll loses the note and the message gets filtered twice,
// which is exactly today's behaviour and no worse; persisting it would buy a
// few seconds of coverage for a rare race at the cost of a real schema.
// `uidMap` also depends on the server reporting COPYUID (IMAP UIDPLUS) — the
// Graph and EWS clients always return it, IMAP servers without the extension
// return null, and there we simply can't tell which copy is ours.
// ---------------------------------------------------------------------------
const FILED_TTL_MS = 6 * 3600e3;
const FILED_MAX = 5000;
const filed = new Map();

const filedKey = (userKey, accountId, folder, uid) => JSON.stringify([userKey, accountId, folder, String(uid)]);

function noteFiled(destination, uidMap) {
  if (!uidMap) return;
  const u = currentUser();
  const now = Date.now();
  // A destination folder that is hidden or out of sync scope is never polled,
  // so nothing ever comes to claim its notes. Sweep on the way in.
  if (filed.size >= FILED_MAX) {
    for (const [k, exp] of filed) if (exp <= now) filed.delete(k);
    if (filed.size >= FILED_MAX) filed.clear();
  }
  for (const newUid of Object.values(uidMap)) {
    filed.set(filedKey(u.userKey, u.accountId, destination, newUid), now + FILED_TTL_MS);
  }
}

/**
 * "Did the filter engine put this message here itself?" Consumes the note, so
 * a second caller for the same uid gets false. Called by sync.js before it
 * runs filters over a folder's newly-arrived uids.
 */
export function claimFiled(userKey, accountId, folder, uid) {
  const k = filedKey(userKey, accountId, folder, uid);
  const exp = filed.get(k);
  if (exp === undefined) return false;
  filed.delete(k);
  return exp > Date.now();
}

/**
 * IMAP mailbox names are case-sensitive with one exception: INBOX, which is
 * case-insensitive by RFC 3501. Trailing separators are noise either way.
 */
function samePath(a, b) {
  const norm = (p) => String(p || '').trim().replace(/[/.]+$/, '');
  const x = norm(a);
  const y = norm(b);
  if (x === y) return true;
  return x.toUpperCase() === 'INBOX' && y.toUpperCase() === 'INBOX';
}

function testRule(msg, rule, fullText) {
  const { field, op } = rule;
  let value = rule.value;

  if (field === 'size') {
    const size = fieldValue(msg, 'size');
    const target = parseInt(value, 10) * 1024; // value in KB
    if (op === 'greater') return size > target;
    if (op === 'less') return size < target;
    return size === target;
  }
  if (field === 'date') {
    const d = fieldValue(msg, 'date');
    if (!d) return false;
    const target = new Date(value);
    if (op === 'greater') return d > target;
    if (op === 'less') return d < target;
    return d.toDateString() === target.toDateString();
  }

  const subject = field === 'content' ? (fullText || '') : String(fieldValue(msg, field));
  const hay = subject.toLowerCase();
  const needle = String(value || '').toLowerCase();
  if (op === 'contains') return hay.includes(needle);
  if (op === 'notContains') return !hay.includes(needle);
  if (op === 'is') return hay === needle;
  return false;
}

/**
 * The From: a filter's `redirect`/`reply` goes out as.
 *
 * Without this, sendMail falls back to `identities.find(i => i.default)` — the
 * GLOBAL default identity — and then to whichever account that identity belongs
 * to. So a rule matching in account B auto-replied as account A, over A's SMTP,
 * to someone who had written to B. Prefer an identity belonging to the account
 * the filter actually ran for, exactly the way accounts.js and compose.js
 * already pick one; fall back to the old behaviour only when that account has no
 * identity of its own, since sending as the wrong address still beats not
 * sending at all.
 */
function identityIdForCurrentAccount() {
  const accountId = currentUser().accountId;
  if (!accountId) return undefined;
  const ids = store.getIdentities();
  const own = ids.find((i) => i.accountId === accountId && i.default) || ids.find((i) => i.accountId === accountId);
  return own?.id;
}

// Forwarding pulls each attachment's bytes down separately (getAttachment is
// per-index, and is the only shape every protocol client offers), so this is
// bounded on both axes — a filter quietly re-uploading a 40MB deck to someone
// on every delivery is its own kind of broken, and most SMTP servers would
// reject it anyway.
const FORWARD_MAX_ATTACHMENTS = 10;
const FORWARD_MAX_BYTES = 15 * 1024 * 1024;

/**
 * Attachment bytes for a forward, in the shape sendMail wants. Inline images
 * keep their `cid`, so the forwarded HTML's `cid:` references still resolve
 * instead of rendering as broken images at the other end.
 */
async function attachmentsForForward(folder, uid, list, filterName) {
  const out = [];
  let bytes = 0;
  for (const a of list || []) {
    if (out.length >= FORWARD_MAX_ATTACHMENTS) {
      flog.warn(`${filterName}: forwarding only the first ${FORWARD_MAX_ATTACHMENTS} attachment(s) of message ${uid}`);
      break;
    }
    if (bytes + (a.size || 0) > FORWARD_MAX_BYTES) {
      flog.warn(`${filterName}: skipping attachment "${a.filename}" of message ${uid} — over the ${Math.round(FORWARD_MAX_BYTES / 1048576)}MB forward budget`);
      continue;
    }
    try {
      const full = await getAttachment(folder, uid, a.index);
      if (!full?.content) continue;
      bytes += full.content.length;
      out.push({
        filename: full.filename || a.filename,
        contentType: full.contentType || a.contentType,
        contentBase64: Buffer.from(full.content).toString('base64'),
        cid: a.cid || undefined,
      });
    } catch (e) {
      // One unreadable part must not cost the whole forward.
      flog.warn(`${filterName}: could not read attachment "${a.filename}" of message ${uid}:`, e.message);
    }
  }
  return out;
}

/**
 * What a filter's send is recorded against. The Message-ID is the right key:
 * stable across folders, across the new uid a MOVE mints, and across restarts —
 * which is exactly what "once per delivered message" means. A message with no
 * Message-ID at all (rare, but legal) falls back to folder+uid; that still stops
 * the repeated-manual-run case this exists for, it just can't follow the message
 * if a filter later moves it.
 *
 * NUL built at runtime rather than written as an escape, matching the same
 * choice elsewhere in this codebase.
 */
function sendKey(full, folder, uid) {
  return full?.messageId || folder + String.fromCharCode(0) + uid;
}
function claimSend(full, folder, uid, filter) {
  const u = currentUser();
  return claimFilterSend(u.userKey, u.accountId, sendKey(full, folder, uid), filter.id || filter.name);
}
function releaseSend(full, folder, uid, filter) {
  const u = currentUser();
  releaseFilterSend(u.userKey, u.accountId, sendKey(full, folder, uid), filter.id || filter.name);
}

// `move` and `delete` end this message's business in this folder — its uid stops
// being valid, so nothing after them can run. Every other action is a side
// effect that leaves the message where it is. Sorting the terminal ones last
// means the order they were listed in no longer changes what happens: a rule
// written as [move, redirect] used to send NOTHING, because the move broke out
// of the loop before redirect was ever reached. Array#sort is stable, so
// actions keep their relative order within each group.
const TERMINAL_ACTIONS = new Set(['move', 'delete']);
function orderedActions(actions) {
  return [...(actions || [])].sort((a, b) => (TERMINAL_ACTIONS.has(a.type) ? 1 : 0) - (TERMINAL_ACTIONS.has(b.type) ? 1 : 0));
}

/**
 * `messages`, when passed, is used as-is instead of re-fetching the folder —
 * the background poller (sync.js) already has fresh envelopes for the UIDs
 * it just detected as new, so filtering those costs nothing extra on top of
 * the sync itself, rather than a whole separate `listMessages` round trip.
 */
export async function runFilters(folder, { onlyUnseen = false, messages: providedMessages = null, once = false } = {}) {
  // Always called inside an account's ALS context (sync.js's pollFolder, or
  // the /api/filters/run route via requireAuth's ?account= param) — never
  // undefined in practice, but treat a missing accountId as "matches
  // nothing account-specific" rather than throwing.
  const activeAccountId = currentUser().accountId || null;
  const filters = store.getFilters().filter((f) => f.enabled && (!f.accountId || f.accountId === activeAccountId));
  if (!filters.length) return { matched: 0, applied: [], departed: [], targets: [] };

  const messages = providedMessages || (await listMessages(folder, { page: 1, pageSize: 200, unreadOnly: onlyUnseen })).messages;
  const applied = [];
  // Which uids are no longer in `folder` when we're done, and which folders we
  // put things into. This module does the IMAP work but deliberately owns no
  // cache of its own (importing cache.js here is fine; importing sync.js would
  // be a cycle, since sync.js imports this) — so it reports what it changed and
  // the caller reconciles. Both callers must: sync.js#pollFolder and
  // /api/filters/run. Without it the moved message's row sits in the source
  // folder until the next FULL scan's pruneMissing — up to ~20 minutes — and
  // for all that time the unified list shows it twice, once from the stale row
  // and once from the real one in the folder it was filed into.
  const departed = [];
  const touched = new Set();

  for (const msg of messages) {
    for (const filter of filters) {
      const needsContent = filter.rules?.some((r) => r.field === 'content');
      let fullText = '';
      if (needsContent) {
        try {
          const full = await getMessage(folder, msg.uid);
          fullText = full.text || full.html || '';
        } catch { /* skip content test */ }
      }

      let match;
      if (filter.match === 'always') match = true;
      else if (filter.match === 'any') match = (filter.rules || []).some((r) => testRule(msg, r, fullText));
      else match = (filter.rules || []).every((r) => testRule(msg, r, fullText));

      if (!match) continue;
      // `once`: has this filter already been applied to this message? True
      // exactly once, forever after false (cache.js#claimFilterApplied). It is
      // what lets the automatic run reach back over a catch-up window that
      // overlaps a previous one without filing anything twice — and what makes
      // a wiped cache, which re-presents every message as new, harmless.
      //
      // Deliberately NOT set for the interactive "Run filters now": pressing
      // that button means "do it again", and a ledger that silently refused
      // would make the button look broken.
      // Same key and same identifier as claimSend above, so the two ledgers
      // agree about what "this message" and "this filter" mean.
      const claimKey = sendKey(msg, folder, msg.uid);
      const claimId = filter.id || filter.name;
      if (once && !claimFilterApplied(currentUser().userKey, currentUser().accountId, claimKey, claimId)) {
        flog.debug(`${folder}/${msg.uid}: "${filter.name}" already applied — skipping`);
        continue;
      }
      applied.push({ uid: msg.uid, subject: msg.subject, filter: filter.name });

      let moved = false;
      // Deliberately separate from `moved`, which is control flow ("stop
      // processing this message") and must keep behaving exactly as it did.
      // This one is a fact about the mailbox: the uid is genuinely gone from
      // this folder. They differ for `delete` under deleteBehavior='flag'.
      let departedHere = false;
      // One action of this filter threw. Everything after it is abandoned (see
      // the catch below) and the remaining filters are left alone too — with
      // the mailbox in a state this rule did not intend, letting the next rule
      // act on the same message compounds the guess.
      let actionFailed = false;
      for (const action of orderedActions(filter.actions)) {
        try {
          switch (action.type) {
            // Moving a message into the folder it is already in looks like a
            // no-op but is not one on IMAP: MOVE is COPY + EXPUNGE, so the
            // server hands the copy a brand new UID. sync.js sees that UID
            // above the folder's high-water mark, calls it new mail, runs
            // filters over it, moves it again... a loop that burns a UID and
            // fires a push notification every polling cycle until the
            // message's Date header finally falls out of sync.js's two-day
            // "genuinely new mail" window. Every "to: x@example.com -> move to
            // INBOX.X" rule walks into this the moment the message lands in
            // INBOX.X and that folder gets polled in its own right, which is
            // how one overnight message turned into ten identical
            // notifications and three cached copies of itself. Copy is worse
            // still: into the same folder it genuinely duplicates the message
            // on the server, every cycle, forever.
            case 'move':
              if (samePath(folder, action.value)) {
                flog.debug(`${filter.name}: message ${msg.uid} is already in ${action.value} — skipping self-move`);
                break;
              }
              noteFiled(action.value, (await moveMessages(folder, [msg.uid], action.value))?.uidMap);
              touched.add(action.value);
              moved = true;
              departedHere = true;
              break;
            case 'copy':
              if (samePath(folder, action.value)) {
                flog.debug(`${filter.name}: message ${msg.uid} is already in ${action.value} — skipping self-copy`);
                break;
              }
              // Same note as a move: our own copy is about to show up as
              // "new mail" in a folder the poller also watches, and would be run
              // through the filters a second time. (IMAP reports COPYUID so the
              // note can be written; Graph and EWS don't return one for a copy,
              // and there the send ledger below is what still holds the line.)
              noteFiled(action.value, (await copyMessages(folder, [msg.uid], action.value))?.uidMap);
              touched.add(action.value);
              break;
            case 'markRead': await setFlags(folder, [msg.uid], { add: ['\\Seen'] }); break;
            case 'markUnread': await setFlags(folder, [msg.uid], { remove: ['\\Seen'] }); break;
            case 'star': await setFlags(folder, [msg.uid], { add: ['\\Flagged'] }); break;
            case 'delete': {
              const res = await deleteMessages(folder, [msg.uid]);
              moved = true;
              // deleteBehavior='flag' just adds \\Deleted and leaves the message
              // exactly where it is — the uid is still valid and the cached row
              // still describes something real, so it must NOT be dropped.
              // 'moved' (to Trash) and an expunge both genuinely take it out of
              // this folder. imapClient#deleteMessages reports which happened
              // precisely because callers have to mirror it correctly.
              departedHere = res?.action !== 'flagged';
              if (res?.destination) touched.add(res.destination);
              break;
            }
            case 'redirect': {
              const full = await getMessage(folder, msg.uid);
              if (!claimSend(full, folder, msg.uid, filter)) {
                flog.debug(`${filter.name}: already forwarded message ${msg.uid} once — not sending again`);
                break;
              }
              try {
                await sendMail({
                  identityId: identityIdForCurrentAccount(),
                  to: action.value,
                  subject: 'Fwd: ' + full.subject,
                  html: full.html || undefined,
                  text: full.text || undefined,
                  attachments: await attachmentsForForward(folder, msg.uid, full.attachments, filter.name),
                });
              } catch (e) {
                // Hand the claim back so a later run can retry — a claim left
                // standing on a send that never happened would mean this message
                // is never forwarded at all.
                releaseSend(full, folder, msg.uid, filter);
                throw e;
              }
              break;
            }
            case 'reply': {
              const full = await getMessage(folder, msg.uid);
              const replyTo = full.replyTo?.[0]?.address || full.from?.[0]?.address;
              if (!replyTo) break;
              if (!claimSend(full, folder, msg.uid, filter)) {
                flog.debug(`${filter.name}: already auto-replied to message ${msg.uid} once — not sending again`);
                break;
              }
              try {
                await sendMail({
                  identityId: identityIdForCurrentAccount(),
                  to: replyTo,
                  subject: 'Re: ' + full.subject,
                  text: action.value || '',
                  inReplyTo: full.messageId,
                });
              } catch (e) {
                releaseSend(full, folder, msg.uid, filter);
                throw e;
              }
              break;
            }
          }
        } catch (e) {
          // Stop this filter here. Continuing was actively dangerous: the
          // actions of one rule are a sequence the user intended to happen
          // together, so running the rest after one failed produces a state
          // they never asked for — the worst case being a `move` that failed
          // followed by a `delete` that succeeded, which destroys the message
          // instead of filing it.
          //
          // Recorded where the user can actually see it, because nothing else
          // in this path surfaces: a filter runs in the background poller with
          // no request to fail and no UI attached, so before this the only
          // trace was a line in the server's stdout.
          flog.warn(`Filter action ${action.type} failed:`, e.message);
          const u = currentUser();
          userLog.record(u.userKey, {
            level: 'error',
            category: 'filter',
            message: `Filter "${filter.name}": ${action.type} failed`,
            detail: `${e.message}\nMessage: ${msg.subject || '(no subject)'}\nFolder: ${folder}`,
            accountId: u.accountId,
          });
          actionFailed = true;
          // Give the claim back, so a later run may try this filter on this
          // message again. Same reasoning as releaseSend: a claim that stands
          // after a failure means the rule silently never runs — the message
          // is left half-filed and nothing ever comes back for it.
          if (once) releaseFilterApplied(currentUser().userKey, currentUser().accountId, claimKey, claimId);
          break;
        }
        if (moved) break; // uid no longer valid in this folder
      }
      if (departedHere) departed.push(msg.uid);
      if (actionFailed) break; // this message is in an unintended state — don't pile on
      if (moved) break; // stop processing further filters for this message
    }
  }
  return { matched: applied.length, applied, departed, targets: [...touched] };
}
