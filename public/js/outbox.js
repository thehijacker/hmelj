// Hmelj — the outbox: what happens to a write while the server is unreachable.
//
// Every mail action in this app is already OPTIMISTIC — quickToggleRead flips
// the row and then posts, quickDelete takes the row out and then posts, and both
// put it back if the post fails (see app.js). Offline mode reuses that whole
// mechanism rather than duplicating it: the post doesn't fail, it is queued, and
// the call resolves with a synthetic acknowledgement. Not one of the ~20
// mutation call sites in app.js needed changing.
//
// That leaves exactly one problem, and it is the reason this file is more than
// a list: a queued action has not happened on the server, so the next READ —
// a reconcile, a folder reopen, a fresh boot — comes back out of the offline
// cache still describing the world as it was before, and paints the action away
// again. The fix is the **overlay**: every queued op also states what it did to
// which message, and offline.js runs every cached list, message and unread count
// through it on the way out. An op's overlay entry dies with the op, the moment
// it has really been applied on the server.
//
// Replay is deliberately conservative. FIFO, one at a time, stopping at the
// first transport failure (the connection went away again — everything after it
// would fail too). A refusal from a server that *did* answer is different: the
// message has moved or been deleted from another client while this device was
// away, that op can never succeed, and retrying it forever would be a queue
// that never drains. Those are dropped and reported once.
const Outbox = (() => {
  const MAX_TRIES = 5;

  let ops = [];               // pending + failed, in id order
  let overlay = new Map();    // "account\0folder\0uid" -> {add:Set, remove:Set, removed:bool}
  let ready = false;
  let replaying = false;
  const listeners = [];

  const keyOf = (account, folder, uid) => [account || '', folder || '', uid].join('\u0000');
  const lower = (f) => String(f).toLowerCase();

  function emit() { for (const fn of listeners) { try { fn(); } catch (e) { console.error('outbox listener failed', e); } } }
  function onChange(fn) { listeners.push(fn); }

  /* ---------- loading and bookkeeping ---------- */

  async function init() {
    ops = (await OfflineDb.getAll('outbox')) || [];
    ops.sort((a, b) => a.id - b.id);
    rebuildOverlay();
    ready = true;
    emit();
    return ops.length;
  }

  /** The overlay is derived state, never stored: it is rebuilt from the queue
   * whenever the queue changes. One source of truth, and no way for the two to
   * drift apart after a reload. */
  function rebuildOverlay() {
    overlay = new Map();
    for (const op of ops) applyToOverlay(op);
  }

  function entry(k) {
    let e = overlay.get(k);
    if (!e) { e = { add: new Set(), remove: new Set(), removed: false }; overlay.set(k, e); }
    return e;
  }

  function applyToOverlay(op) {
    const p = op.payload || {};
    switch (op.type) {
      case 'flags':
        for (const uid of p.uids || []) {
          const e = entry(keyOf(op.account, p.folder, uid));
          for (const f of p.add || []) { e.add.add(lower(f)); e.remove.delete(lower(f)); }
          for (const f of p.remove || []) { e.remove.add(lower(f)); e.add.delete(lower(f)); }
        }
        break;
      case 'delete':
      case 'move':
      case 'refile':
        // All three take the message out of the folder it is listed in. Where
        // it lands is the server's business (and, for refile, the account's own
        // Junk/Archive setting) — nothing here needs to model the destination,
        // because the destination folder's own cached listing is refreshed from
        // the server the moment the connection is back.
        for (const uid of p.uids || []) entry(keyOf(op.account, p.folder, uid)).removed = true;
        break;
      default: // send, draft — nothing in the mailbox changes until they replay
        break;
    }
  }

  const pending = () => ops.filter((o) => o.state !== 'failed');
  const count = () => ops.length;
  const list = () => ops.slice();
  const isReady = () => ready;
  const isReplaying = () => replaying;

  /** Whether a write should be queued instead of sent. Asked by api.js BEFORE
   * it tries, and again after a transport failure. Never true during replay —
   * that is the one caller whose failures must surface. */
  function shouldQueue() {
    if (!ready || replaying) return false;
    if (window.Offline?.enabled?.() === false) return false;
    return window.Connection?.isOnline?.() === false;
  }

  /* ---------- queueing ---------- */

  /**
   * How many unread messages this op takes off (or puts back on) a badge.
   *
   * Read from the cached envelopes at queue time, because that is the only
   * moment the answer is knowable: afterwards the overlay has already changed
   * what a read of those messages reports. Mirrors exactly the bookkeeping
   * app.js does optimistically in memory (adjustUnreadCounts), so the badge a
   * cached /api/unread produces agrees with the one on screen.
   */
  async function unreadDeltaFor(type, account, folder, uids, add = [], remove = []) {
    const envs = await window.Offline?.envelopes?.() || [];
    const seenOf = new Map();
    for (const e of envs) {
      if (e.account === account && e.folder === folder) seenOf.set(String(e.uid), !!e.msg?.seen);
    }
    let delta = 0;
    for (const uid of uids || []) {
      const wasSeen = seenOf.get(String(uid));
      if (wasSeen === undefined) continue; // not in the cache — guessing would be worse than not moving the badge
      if (type === 'flags') {
        if (add.some((f) => lower(f) === '\\seen') && !wasSeen) delta -= 1;
        if (remove.some((f) => lower(f) === '\\seen') && wasSeen) delta += 1;
      } else if (!wasSeen) {
        delta -= 1; // delete / move / refile: it leaves this folder, and its badge
      }
    }
    return delta;
  }

  /**
   * Put one write on the queue and answer the caller as though it had gone out.
   *
   * The synthetic answers are shaped so the existing call sites behave
   * correctly rather than merely not crashing. A queued delete deliberately
   * carries no `action`/`uidMap`, which is what makes offerUndoDelete() decline
   * to offer an undo (app.js) — an undo that posts a second request the server
   * has never heard of would be worse than none, and the Outbox view is where a
   * queued action is taken back.
   */
  async function enqueue(type, meta) {
    const { account = '', payload = {} } = meta;
    const op = {
      user: localStorage.getItem('hmelj-offline-user') || '',
      type, account, payload,
      at: Date.now(), tries: 0, state: 'pending', lastError: '',
      unreadDelta: 0,
    };
    if (type === 'flags' || type === 'delete' || type === 'move' || type === 'refile') {
      op.unreadDelta = await unreadDeltaFor(type, account, payload.folder, payload.uids, payload.add, payload.remove);
    }
    // One compose window (see app.js's #compose-window), so a draft autosave
    // supersedes the previous autosave of the same draft rather than queueing a
    // second one — otherwise a ten-minute offline compose replays as a dozen
    // near-identical drafts.
    if (type === 'draft') {
      const same = ops.find((o) => o.type === 'draft'
        && (o.payload?.payload?.previousUid ?? null) === (payload.payload?.previousUid ?? null));
      if (same) await drop(same.id);
    }
    const id = await OfflineDb.put('outbox', op);
    op.id = typeof id === 'number' ? id : Date.now();
    ops.push(op);
    ops.sort((a, b) => a.id - b.id);
    applyToOverlay(op);
    emit();
    return ackFor(type, payload);
  }

  function ackFor(type, payload) {
    switch (type) {
      case 'draft':
        // The draft is not on the server, so there is no new uid to report.
        // Handing back the one it already had (or null) keeps compose.js's
        // draftUid honest: it still names the server-side copy, if any.
        return { uid: payload.payload?.previousUid ?? null, queued: true };
      case 'send':
        return { queued: true };
      case 'delete':
        return { queued: true, count: payload.uids?.length || 0 };
      default:
        return { ok: true, queued: true };
    }
  }

  /* ---------- the queue's own edits ---------- */

  async function drop(id) {
    await OfflineDb.del('outbox', id);
    ops = ops.filter((o) => o.id !== id);
    rebuildOverlay();
    emit();
  }

  async function update(op) {
    await OfflineDb.put('outbox', op);
    const i = ops.findIndex((o) => o.id === op.id);
    if (i !== -1) ops[i] = op;
    rebuildOverlay();
    emit();
  }

  /** Take a failed op off "failed" so the next pass tries it again — the Retry
   *  button in the Outbox view. */
  async function retry(id) {
    const op = ops.find((o) => o.id === id);
    if (!op) return;
    op.state = 'pending';
    op.tries = 0;
    op.lastError = '';
    await update(op);
    replay();
  }

  async function clear() {
    for (const op of ops.slice()) await OfflineDb.del('outbox', op.id);
    ops = [];
    rebuildOverlay();
    emit();
  }

  /* ---------- replay ---------- */

  /** The real request behind one queued op. Runs with `replaying` set, so
   *  api.js sends it instead of queueing it again. */
  function send(op) {
    const p = op.payload || {};
    const acct = op.account || undefined;
    switch (op.type) {
      case 'flags': return API.flags(p.folder, p.uids, p.add, p.remove, acct);
      case 'delete': return API.deleteMsgs(p.folder, p.uids, acct);
      case 'move': return API.move(p.folder, p.uids, p.target, acct);
      case 'copy': return API.copy(p.folder, p.uids, p.target, acct);
      case 'refile': return API.refile(p.folder, p.uids, p.box, p.revert, acct);
      case 'send': return API.send(p.payload, acct);
      case 'draft': return API.saveDraft(p.payload, acct);
      default: return Promise.reject(new Error('unknown queued action: ' + op.type));
    }
  }

  /**
   * Drain the queue.
   *
   * Two failure modes, treated as the different things they are:
   *
   *  - `.offline` (nothing answered) — the connection went away again. Stop the
   *    whole pass: every op after this one would fail the same way, and burning
   *    their retry counters on a dead link would eventually throw away work
   *    that was never actually refused.
   *  - a status from a server that DID answer — 404/410 mean the message is not
   *    there any more (moved or deleted from another client while this device
   *    was away, or an IMAP uid that went stale). That op can never succeed;
   *    keeping it would be a queue that never empties and a row that never stops
   *    lying. Dropped, and reported once.
   *
   * Anything else (a 5xx, a timeout that still produced a response) is retried
   * up to MAX_TRIES and then parked as `failed`, which is what the Outbox view
   * offers a Retry button for.
   */
  async function replay({ onDropped = null } = {}) {
    if (replaying || !ready) return { sent: 0, dropped: 0 };
    if (!window.Connection?.isOnline?.()) return { sent: 0, dropped: 0 };
    replaying = true;
    let sent = 0;
    const dropped = [];
    try {
      for (const op of pending()) {
        if (!window.Connection?.isOnline?.()) break;
        try {
          await send(op);
          await drop(op.id);
          sent++;
        } catch (e) {
          if (e?.offline) break;
          const gone = e?.status === 404 || e?.status === 410;
          if (gone) {
            dropped.push({ op, reason: e.message });
            await drop(op.id);
            continue;
          }
          op.tries = (op.tries || 0) + 1;
          op.lastError = e?.message || 'failed';
          if (op.tries >= MAX_TRIES) op.state = 'failed';
          await update(op);
          // A refusal of THIS op says nothing about the next one — keep going,
          // unlike the transport break above.
        }
      }
    } finally {
      replaying = false;
    }
    if (dropped.length && onDropped) onDropped(dropped);
    emit();
    return { sent, dropped: dropped.length, list: dropped };
  }

  /* ---------- the overlay, applied to cached reads ---------- */

  /** Flags a message really has right now, as far as this device is concerned:
   *  what the server last said, plus what is queued on top of it. */
  function withOverlay(msg, e) {
    const flags = new Set((msg.flags || []).map(lower));
    for (const f of e.add) flags.add(f);
    for (const f of e.remove) flags.delete(f);
    return {
      ...msg,
      // Cased as the server cases them — '\\Seen', not '\\seen' — so anything
      // comparing against a literal keeps working.
      flags: [...flags].map((f) => (f.startsWith('\\') ? '\\' + f.slice(1, 2).toUpperCase() + f.slice(2) : f)),
      seen: flags.has('\\seen'),
    };
  }

  /**
   * A cached listing with the queue applied: messages taken out by a queued
   * delete/move/refile are gone, and flags a queued op changed read as changed.
   *
   * `ctx` is the account/folder a row inherits when it doesn't name its own —
   * a single-account folder listing, where the request URL carried both. Null
   * for a unified or locally-built list, whose rows always name their own.
   */
  function decorateList(data, ctx) {
    if (!overlay.size || !data?.messages) return data;
    let removed = 0;
    const messages = [];
    for (const m of data.messages) {
      const account = m.account?.id || ctx?.account || '';
      const folder = m.folder || ctx?.folder || '';
      const e = overlay.get(keyOf(account, folder, m.uid));
      if (!e) { messages.push(m); continue; }
      if (e.removed) { removed++; continue; }
      messages.push(withOverlay(m, e));
    }
    // A conversation's payload carries no `total` — only a listing does — and
    // inventing one here would put a field on it that nothing wrote and
    // something might one day read.
    const total = data.total === undefined ? {} : { total: Math.max(0, data.total - removed) };
    return { ...data, messages, ...total };
  }

  /** One cached message body with the queue applied. `ref` is what offline.js
   *  parsed out of the request URL. */
  function decorateMessage(msg, ref) {
    const e = overlay.get(keyOf(ref.account, ref.folder, ref.uid));
    return e && !e.removed ? withOverlay(msg, e) : msg;
  }

  /**
   * One row, when the caller already knows which mailbox it came from — null
   * if a queued action took it out of that mailbox.
   *
   * decorateList above can only read the account off the row itself or off the
   * request URL, and a locally-built listing (Offline.buildList) has neither: it
   * is assembled from stored envelopes, each of which knows its own account
   * independently of any row or URL. This is that path.
   */
  function decorateRow(msg, account, folder) {
    const e = overlay.get(keyOf(account, folder, msg.uid));
    if (!e) return msg;
    return e.removed ? null : withOverlay(msg, e);
  }

  /**
   * The cached folder list, with each folder's unread count moved by whatever
   * is queued against it.
   *
   * The same problem decorateUnread solves, one level down and just as
   * visible: reconcileFolders() re-reads /api/folders and writes every badge in
   * the sidebar from it. Offline that read comes out of the cache, which still
   * has the counts from before anything was marked read — so without this, the
   * sidebar silently undid every offline mark-as-read a few hundred
   * milliseconds after it happened.
   */
  function decorateFolders(list, account) {
    if (!ops.length || !Array.isArray(list)) return list;
    const byFolder = new Map();
    for (const op of ops) {
      const d = op.unreadDelta || 0;
      const folder = op.payload?.folder;
      if (!d || !folder) continue;
      // A folder list is one account's; an op belonging to another account has
      // nothing to say about it, even when the folder names happen to match.
      if (account && op.account && op.account !== account) continue;
      byFolder.set(folder, (byFolder.get(folder) || 0) + d);
    }
    if (!byFolder.size) return list;
    return list.map((f) => (byFolder.has(f.path)
      ? { ...f, unseen: Math.max(0, (f.unseen || 0) + byFolder.get(f.path)) }
      : f));
  }

  /** The cached unread totals, moved by whatever is queued. Without this, a
   *  reconcile against the cache would put the badge back up seconds after
   *  something was marked read offline. */
  function decorateUnread(data) {
    if (!ops.length || !data) return data;
    const accounts = { ...(data.accounts || {}) };
    let total = data.total || 0;
    for (const op of ops) {
      const d = op.unreadDelta || 0;
      if (!d) continue;
      total += d;
      if (op.account) accounts[op.account] = Math.max(0, (accounts[op.account] || 0) + d);
    }
    return { ...data, total: Math.max(0, total), accounts };
  }

  return {
    init, onChange, count, list, pending, isReady, isReplaying, shouldQueue,
    enqueue, drop, retry, clear, replay,
    decorateList, decorateRow, decorateMessage, decorateUnread, decorateFolders,
  };
})();
if (typeof window !== 'undefined') window.Outbox = Outbox;
