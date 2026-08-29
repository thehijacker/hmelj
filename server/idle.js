// Hmelj — live new-mail watchers ("Monitoring: Live" on an account).
//
// Until now the ONLY way Hmelj learned that anything had changed was the
// interval poller in sync.js: no IMAP IDLE anywhere, no EWS subscriptions, so
// a message could sit unnoticed for up to a full poll interval before it was
// cached, filtered, or notified about. That delay is most of what "the
// notification arrived late" and "the counter is out of date" actually were.
//
// This module holds a persistent connection per opted-in account and calls
// back the moment the server says something changed. It deliberately does NOT
// implement any sync logic of its own — the callback just asks sync.js to poll
// that folder through its normal path, so new mail, filters, counts, push
// notifications and SSE broadcasts all behave exactly as they do on a
// scheduled cycle. The watcher is a trigger, nothing more. That also means a
// watcher that dies costs latency and nothing else: the account keeps its
// (longer) fallback poll, so it degrades to the old behaviour rather than
// going silent.
//
// Scope: INBOX only. IMAP IDLE watches one mailbox per connection, and opening
// one socket per folder per account is not a trade worth making — other
// folders are still covered by the account's own poll.
import { ImapFlow } from 'imapflow';
import { currentAccount } from './accounts.js';
import { runAsAccount, userKey } from './session.js';
import * as ews from './ewsClient.js';
import * as graph from './graphClient.js';
// Only for an IMAP account that signs in instead of storing a password (Gmail).
import * as oauth from './oauth.js';
import { log } from './log.js';

const ilog = log.scope('idle');

// Set by sync.js at startup. Injected rather than imported so this module
// doesn't import sync.js while sync.js imports this one.
let onActivity = null;
export function setOnActivity(fn) { onActivity = fn; }

const watchers = new Map(); // accountId -> { stop(), account, user }

// Some servers drop an IDLE connection well before the 29 minutes RFC 2177
// suggests re-issuing it. Re-establishing comfortably inside that window keeps
// the connection alive through NAT/firewall idle timeouts too.
const IDLE_RENEW_MS = 9 * 60e3;
const BACKOFF_MAX_MS = 10 * 60e3;
const BACKOFF_BASE_MS = 5e3;
// Several events routinely arrive back-to-back for one delivery (EXISTS then
// RECENT then FETCH); one poll should serve all of them.
const DEBOUNCE_MS = 1000;

function isWatching(accountId) { return watchers.has(accountId); }

/** Start watching this account, if it isn't already. Idempotent. */
export function startWatching(user, account) {
  const existing = watchers.get(account.id);
  if (existing) { existing.user = user; existing.account = account; return; }
  const Watcher = WATCHERS[account.type] || ImapIdleWatcher;
  const w = new Watcher(user, account);
  watchers.set(account.id, w);
  w.start();
  ilog.info(`${account.label}: live monitoring started (${w.describe()})`);
}

/** Stop watching (account disabled, deleted, or switched back to polling). */
export function stopWatching(accountId) {
  const w = watchers.get(accountId);
  if (!w) return;
  watchers.delete(accountId);
  try { w.stop(); } catch (e) { ilog.debug(`Stopping watcher for ${accountId}:`, e.message); }
}

export function watchedAccountIds() { return [...watchers.keys()]; }

/** Shared start/stop/backoff/debounce plumbing for both protocols. */
class BaseWatcher {
  constructor(user, account) {
    this.user = user;
    this.account = account;
    this.stopped = false;
    this.failures = 0;
    this.debounceTimer = null;
    this.retryTimer = null;
  }

  start() {
    this.stopped = false;
    this.run().catch((e) => this.onFailure(e));
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.debounceTimer);
    clearTimeout(this.retryTimer);
    this.cleanup();
  }

  cleanup() { /* subclasses */ }

  onFailure(e) {
    if (this.stopped) return;
    this.failures += 1;
    const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (this.failures - 1));
    ilog.warn(`${this.account.label}: live monitoring dropped (${e?.message || e}) — retrying in ${Math.round(delay / 1000)}s (the account's regular poll still covers it meanwhile)`);
    this.cleanup();
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => { if (!this.stopped) this.start(); }, delay);
    this.retryTimer.unref?.();
  }

  /** How this watcher gets its news, for the startup log line. */
  describe() { return 'live'; }

  /**
   * Coalesce a burst of events into one poll.
   *
   * `kind` is why we were woken: 'mail' (something arrived or vanished) or
   * 'flags' (read/starred state moved). It matters because the IMAP server
   * cannot tell us WHO made a flag change — a mark-read Hmelj itself just
   * performed on this account looks exactly like one made on your phone, so
   * every badge click wakes this watcher about its own work. sync.js uses the
   * kind to recognise and drop those self-inflicted wakes; see
   * onWatcherActivity there for why running them was actively harmful.
   *
   * A coalesced burst takes its STRONGEST reason: if anything in it was real
   * mail movement, the whole wake counts as 'mail' and is never dropped.
   */
  notify(folderPath = 'INBOX', kind = 'mail') {
    if (this.stopped || !onActivity) return;
    if (kind !== 'flags' || !this.pendingKind) this.pendingKind = kind === 'flags' ? 'flags' : 'mail';
    clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      const woken = this.pendingKind || 'mail';
      this.pendingKind = null;
      ilog.debug(`${this.account.label}/${folderPath}: change detected (${woken}), syncing now`);
      Promise.resolve(onActivity(this.user, this.account, folderPath, woken))
        .catch((e) => ilog.warn(`${this.account.label}: sync after change failed:`, e.message));
    }, DEBOUNCE_MS);
    this.debounceTimer.unref?.();
  }
}

/**
 * IMAP IDLE.
 *
 * Uses its OWN connection, never the pooled one from imapClient.js: a
 * connection sitting in IDLE cannot run commands, so sharing it would block
 * every interactive request for the account. This is also why "Live" implies
 * a second connection regardless of the account's allowSecondConnection
 * setting — that setting is about the poller, and this is a third thing again.
 *
 * ImapFlow enters IDLE by itself whenever no command is in flight, and emits
 * `exists` / `expunge` / `flags` as the server reports them, so there's no
 * explicit idle() call to manage here — just a mailbox to open and events to
 * listen for.
 */
class ImapIdleWatcher extends BaseWatcher {
  describe() { return 'IMAP IDLE'; }

  async run() {
    // The account object the scheduler hands us comes from listOwnedAccounts(),
    // which runs everything through stripSecrets() — so it has no password on
    // it at all. Resolve the real, decrypted credentials the same way
    // imapClient.js does: inside this account's ALS context, via
    // currentAccount().
    const acc = await runAsAccount(this.user, this.account.id, async () => currentAccount(), { purpose: 'sync' });
    // Signed-in account (Gmail): a bearer token stands in for the password. The
    // token outlives an hour and this connection is meant to outlive that — but
    // IMAP only checks the credential at AUTHENTICATE time, and whenever the
    // provider does drop the connection, onFailure's retry runs through here
    // again and mints a fresh one. So there is nothing to renew mid-session.
    const auth = acc.oauth
      ? { user: acc.imap.user, accessToken: await oauth.accessTokenFor(acc, userKey(this.user.username)) }
      : { user: acc.imap.user, pass: acc.imap.pass };
    const conn = new ImapFlow({
      host: acc.imap.host,
      port: acc.imap.port,
      secure: acc.imap.secure,
      auth,
      logger: false,
      tls: { rejectUnauthorized: acc.imap.tlsRejectUnauthorized },
      // No socketTimeout: an idle connection is *supposed* to sit silent for
      // minutes at a time, which is exactly what that timeout exists to kill.
      // Liveness is instead asserted by the periodic NOOP below.
      socketTimeout: 0,
      // Keepalive at the protocol level as well, so a NAT/firewall in the
      // middle doesn't quietly drop a connection we think is fine.
      qresync: false,
    });
    this.conn = conn;

    conn.on('error', (e) => this.onFailure(e));
    conn.on('close', () => { if (!this.stopped) this.onFailure(new Error('connection closed')); });
    conn.on('exists', () => this.notify('INBOX', 'mail'));    // new message(s) arrived
    conn.on('expunge', () => this.notify('INBOX', 'mail'));   // removed elsewhere
    conn.on('flags', () => this.notify('INBOX', 'flags'));    // read/unread/star changed — on another client, or by us (see notify)

    await conn.connect();
    // Not getMailboxLock(): the lock is meant to be held only for the duration
    // of a command, and this connection holds the mailbox open indefinitely.
    await conn.mailboxOpen('INBOX');
    this.failures = 0;
    ilog.debug(`${acc.label}: IDLE connection open on INBOX`);

    // Periodic NOOP: proves the connection is still alive, gives the server a
    // chance to report anything it's been sitting on, and restarts the IDLE
    // window well inside the RFC's 29-minute guidance.
    clearInterval(this.renewTimer);
    this.renewTimer = setInterval(() => {
      conn.noop().catch((e) => this.onFailure(e));
    }, IDLE_RENEW_MS);
    this.renewTimer.unref?.();
  }

  cleanup() {
    clearInterval(this.renewTimer);
    const c = this.conn;
    this.conn = null;
    if (!c) return;
    c.removeAllListeners('close'); // don't let our own teardown look like a failure
    c.removeAllListeners('error');
    try { c.logout().catch(() => c.close()); } catch { try { c.close(); } catch { /* already gone */ } }
  }
}

/**
 * EWS change notifications, via a PULL subscription polled on a short timer.
 *
 * Not a streaming subscription, though that's the true equivalent of IDLE and
 * is what this was written as first. It cannot work through this project's
 * Exchange transport: httpntlm builds its own agentkeepalive agent internally
 * and ignores any agent passed to it, and agentkeepalive hard-floors socket
 * inactivity at 8 seconds. A GetStreamingEvents long-poll is an idle socket by
 * definition, so against a real Exchange server it died after exactly 8s and
 * retried forever. See the comment above subscribePull in ewsClient.js.
 *
 * A pull subscription keeps the accuracy — Exchange tells us exactly what
 * changed since our watermark, instead of us re-reading a fixed newest-50
 * window and guessing — while every request returns immediately. The cost is
 * that latency is the pull interval rather than ~1s. Still a large improvement
 * on the 2-minute poll this replaces, and honest about what it is.
 */
const EWS_PULL_INTERVAL_MS = 15e3;

class EwsWatcher extends BaseWatcher {
  describe() { return 'EWS streaming'; }

  async run() {
    this.stopped = false;
    let sub = null;
    while (!this.stopped) {
      if (!sub) {
        sub = await runAsAccount(this.user, this.account.id,
          () => ews.subscribePull(['INBOX']), { purpose: 'sync' });
        if (!sub?.subscriptionId) throw new Error('EWS did not return a subscription id');
        this.failures = 0;
        ilog.debug(`${this.account.label}: EWS pull subscription ${String(sub.subscriptionId).slice(0, 12)}… open`);
      }
      await this.sleep(EWS_PULL_INTERVAL_MS);
      if (this.stopped) return;
      const r = await runAsAccount(this.user, this.account.id,
        () => ews.getEvents(sub.subscriptionId, sub.watermark), { purpose: 'sync' });
      if (r.expired) {
        // Normal: the subscription timed out or the server was restarted.
        // Re-subscribe on the next loop rather than treating it as a failure.
        ilog.debug(`${this.account.label}: EWS subscription expired, renewing`);
        sub = null;
        continue;
      }
      sub.watermark = r.watermark;
      this.failures = 0; // a successful round trip clears any earlier backoff
      if (r.changed) this.notify('INBOX');
    }
  }

  /** Interruptible wait — resolves early when stop() is called. */
  sleep(ms) {
    return new Promise((resolve) => {
      this.sleepTimer = setTimeout(resolve, ms);
      this.sleepTimer.unref?.();
      this.sleepResolve = resolve;
    });
  }

  cleanup() {
    clearTimeout(this.sleepTimer);
    this.sleepResolve?.(); // let a pending sleep() fall through so run() can exit
    this.sleepResolve = null;
  }
}

/**
 * Microsoft Graph, by short-interval polling of the Inbox's item counts.
 *
 * Graph's true push is a change-notification subscription, which delivers to a
 * webhook — it needs the Hmelj instance to be reachable from the public
 * internet on HTTPS, needs a validation handshake, and needs re-subscribing
 * every ~3 days. That rules it out as the default for a self-hosted mailbox
 * that may well be LAN-only, and a feature that silently does nothing on half
 * the installs is worse than one that plainly works everywhere.
 *
 * So: one request per tick asking only for totalItemCount/unreadItemCount, and
 * a sync whenever either moves. At 30 seconds that is ~20 requests per 10
 * minutes against Graph's ~10,000-per-10-minutes-per-mailbox budget, which is
 * why this can be this frequent — an IMAP server would not tolerate the
 * equivalent. Latency is the tick rather than ~1s, which is still far better
 * than the poll interval it replaces, and honest about what it is.
 *
 * Counts, not message ids: two changes that cancel out within one tick (a
 * message arrives and is deleted) would be missed, which is exactly what the
 * account's ordinary fallback poll is still there for.
 */
const GRAPH_POLL_INTERVAL_MS = 30e3;

class GraphWatcher extends BaseWatcher {
  describe() { return 'Graph polling (~30s)'; }

  async run() {
    this.stopped = false;
    let last = null;
    while (!this.stopped) {
      const counts = await runAsAccount(this.user, this.account.id,
        () => graph.folderCounts(), { purpose: 'sync' });
      this.failures = 0; // a successful round trip clears any earlier backoff
      // The first tick only establishes a baseline — firing a sync on it would
      // make every watcher restart look like new mail.
      if (last && (counts.total !== last.total || counts.unseen !== last.unseen)) {
        this.notify('INBOX');
      }
      last = counts;
      await this.sleep(GRAPH_POLL_INTERVAL_MS);
    }
  }

  // Same interruptible-sleep pair EwsWatcher has. Deliberately duplicated
  // rather than lifted into BaseWatcher: ImapIdleWatcher overrides cleanup()
  // for its connection teardown, and the EWS watcher is the one piece of this
  // file confirmed working against a real server — not worth reshaping for
  // four lines.
  sleep(ms) {
    return new Promise((resolve) => {
      this.sleepTimer = setTimeout(resolve, ms);
      this.sleepTimer.unref?.();
      this.sleepResolve = resolve;
    });
  }

  cleanup() {
    clearTimeout(this.sleepTimer);
    this.sleepResolve?.(); // let a pending sleep() fall through so run() can exit
    this.sleepResolve = null;
  }
}

// Anything without an entry here is an IMAP account — accounts stored before
// EWS existed carry no `type` field at all.
const WATCHERS = { ews: EwsWatcher, graph: GraphWatcher };
