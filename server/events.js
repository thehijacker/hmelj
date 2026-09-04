// Hmelj — Server-Sent Events: the "something changed, go check" channel that
// makes cross-device sync feel instant instead of waiting for the next poll
// tick (see server/index.js's GET /api/events and the plan doc). Deliberately
// coarse-grained: every broadcast carries no payload beyond the event type
// itself — public/js/app.js already has reconcileMessages()/reconcileFolders()
// (built for the existing 15s poll), which cheaply re-fetch and no-op if
// nothing relevant actually changed, so there's no need to encode a precise
// diff (which folder, which uids, which flags) over the wire for ~13 very
// differently-shaped mutating routes.
//
// A single-process app (like everything else here — see sync.js's own
// in-memory in-flight/backoff maps) — an in-memory Map is all this needs, no
// Redis/pub-sub. Connections are per-browser-tab, not per-account, so this is
// keyed by Hmelj login (userKey), same granularity as push subscriptions.
import { log } from './log.js';
import * as accounts from './accounts.js';
import * as unread from './unread.js';

const slog = log.scope('events');

const clients = new Map(); // userKey -> Set<res>

// The unread total shipped alongside each reconcile signal, so a receiving
// tab can move its badge/tab-title/launcher-icon count in the same tick the
// event arrives instead of waiting on the round trip to /api/unread that its
// reconcile will do anyway. Purely additive: a client that ignores this (or
// gets `null` because we couldn't compute one) just falls back to fetching.
// Cheap — reads the SQLite folder cache only, no IMAP (see unread.js).
const totalFor = unread.unreadTotalForKey;

export function addClient(userKey, res) {
  if (!clients.has(userKey)) clients.set(userKey, new Set());
  clients.get(userKey).add(res);
}

export function removeClient(userKey, res) {
  const set = clients.get(userKey);
  if (!set) return;
  set.delete(res);
  if (!set.size) clients.delete(userKey);
}

/** Tells every open tab/device for this user to reconcile now. Never throws —
 * a write to an already-dead socket (the client went away between our last
 * cleanup and now) just drops that one connection instead of taking the
 * whole broadcast down. */
export function broadcast(key) {
  const set = clients.get(key);
  if (!set || !set.size) return;
  const data = JSON.stringify({ total: totalFor(key) });
  for (const res of set) {
    try {
      res.write(`event: mail-changed\ndata: ${data}\n\n`);
    } catch (e) {
      slog.debug(`Dropping a dead connection for ${key}:`, e.message);
      set.delete(res);
    }
  }
  if (!set.size) clients.delete(key);
}

/** A non-mail change every other tab/device of this ONE Hmelj login should
 * pick up right away — currently only the sidebar's account order (see
 * store.js's accountOrder). Deliberately its own event type rather than
 * riding along on `mail-changed`: that one fires on every message mutation,
 * and making its handler re-fetch settings/accounts each time would turn a
 * cheap reconcile into two extra round trips per marked-read message. Same
 * payload-free philosophy as broadcast() — the client re-reads what it needs.
 * Never throws (dead sockets are dropped, same as broadcast). */
export function broadcastSettings(key) {
  const set = clients.get(key);
  if (!set || !set.size) return;
  for (const res of set) {
    try {
      res.write('event: settings-changed\ndata: {}\n\n');
    } catch (e) {
      slog.debug(`Dropping a dead connection for ${key}:`, e.message);
      set.delete(res);
    }
  }
  if (!set.size) clients.delete(key);
}

/** Same as broadcast(), but for a mutation on one specific mail account —
 * fans out to its owner AND every grantee it's shared with (see
 * accounts.js#accessorKeysFor), not just whoever's ALS context the request
 * happened to run under. Needed because a shared account's mutations always
 * run under its OWNER's userKey (see session.js's requireAuth ownership
 * swap) — a plain broadcast(userKey) from inside one of those routes would
 * only ever reach the owner's own open tabs, never a grantee's. */
export function broadcastForAccount(ownerUserKey, accountId) {
  for (const key of accounts.accessorKeysFor(ownerUserKey, accountId)) broadcast(key);
}

/**
 * A background analytics scan (server/analytics.js) finished or was stopped.
 * Its own event type rather than riding on mail-changed: no mail actually
 * changed, and the reaction is different too — a toast, wherever the user
 * happens to be, plus a refresh of the analytics page only if it's open. That
 * matters because a scan outlives the dialog that started it (and outlives a
 * page reload), so the thing that announces its end can't live inside that
 * dialog. Same owner+grantee fan-out as broadcastForAccount, same
 * never-throw handling as broadcast().
 */
export function broadcastAnalytics(ownerUserKey, accountId, payload = {}) {
  const data = JSON.stringify({ accountId, ...payload });
  for (const key of accounts.accessorKeysFor(ownerUserKey, accountId)) {
    const set = clients.get(key);
    if (!set || !set.size) continue;
    for (const res of set) {
      try {
        res.write(`event: analytics-scan\ndata: ${data}\n\n`);
      } catch (e) {
        slog.debug(`Dropping a dead connection for ${key}:`, e.message);
        set.delete(res);
      }
    }
    if (!set.size) clients.delete(key);
  }
}
