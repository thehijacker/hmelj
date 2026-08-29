// Hmelj — "can we reach the Hmelj server right now?", and telling the user when
// we can't.
//
// Hmelj is a thin client: with no backend there is no mail, no folder list, no
// search — nothing it can usefully do offline. So the honest thing is to say so
// plainly and get out of the way, rather than let every action fail one cryptic
// "Failed to fetch" toast at a time.
//
// Why this isn't just navigator.onLine: that flag only says whether the DEVICE
// has *a* network. It is true on a café Wi-Fi that hasn't been paid for, true on
// mobile data when the server is only reachable over the home VPN, and true when
// the server itself is down or restarting — all cases where Hmelj is just as
// dead as with the radio switched off, and all cases this app hits routinely
// because it's self-hosted. Reachability is therefore decided by what actually
// happens to requests:
//
//   - a request that fails at the transport level (fetch rejects), or comes back
//     from the service worker's offline fallback (X-Hmelj-Offline), = unreachable
//   - any successful response = reachable
//   - while unreachable, GET /api/session is polled (backing off 4s → 30s) until
//     it answers; the browser's own 'online' event just triggers an immediate
//     probe instead of being trusted on its own
//
// /api/session is the probe because it's the one route that's public (no session
// needed, so it can't 401), cheap, and already tells us the other thing worth
// knowing — whether we're still logged in.
const Connection = (() => {
  const PROBE_MIN_MS = 4000;
  const PROBE_MAX_MS = 30000;

  let reachable = true;          // optimistic until something says otherwise
  let started = false;
  let probeTimer = null;
  let probeDelay = PROBE_MIN_MS;
  let probing = false;
  const listeners = [];

  const $el = (id) => document.getElementById(id);

  /** One probe. Resolves true only when the server actually answered. */
  async function probeOnce() {
    try {
      // cache: 'no-store' so neither the HTTP cache nor a stale bfcache entry
      // can make a dead server look alive.
      const res = await fetch('/api/session', { cache: 'no-store' });
      if (res.headers.get('X-Hmelj-Offline')) return null; // service worker's offline stand-in
      if (!res.ok) return null;                            // reachable but not serving (restarting, proxy error)
      return await res.json();
    } catch {
      return null;                                         // DNS/TLS/transport — nothing answered
    }
  }

  function stopProbe() {
    clearTimeout(probeTimer);
    probeTimer = null;
    probeDelay = PROBE_MIN_MS;
  }

  function scheduleProbe(delay = probeDelay) {
    clearTimeout(probeTimer);
    probeTimer = setTimeout(runProbe, delay);
  }

  async function runProbe() {
    if (probing) return;
    probing = true;
    let session = null;
    try { session = await probeOnce(); } finally { probing = false; }
    if (session) {
      setReachable(true);
      return;
    }
    probeDelay = Math.min(PROBE_MAX_MS, Math.round(probeDelay * 1.6));
    scheduleProbe();
  }

  function render() {
    const bar = $el('offline-banner');
    if (bar) bar.hidden = reachable;
    document.getElementById('app')?.classList.toggle('offline', !reachable);
    const dot = $el('conn-status');
    if (dot) {
      dot.classList.toggle('offline', !reachable);
      if (!reachable) dot.title = I18n.t('No connection to the Hmelj server');
    }
  }

  function setReachable(next) {
    const changed = next !== reachable;
    reachable = next;
    if (!next) scheduleProbe(PROBE_MIN_MS); else stopProbe();
    if (!changed) return;
    render();
    for (const fn of listeners) {
      try { fn(reachable); } catch (e) { console.error('connection listener failed', e); }
    }
  }

  /** Called by api.js on every request outcome — successes are just as
   * important as failures here, since they're what ends an outage without
   * waiting for the next probe tick. */
  function noteSuccess() { if (!reachable) setReachable(true); }
  function noteFailure() { setReachable(false); }

  /** The boot-time session read: same probe, but the caller needs the answer.
   * Returns null when the server couldn't be reached at all — which is a very
   * different thing from "not logged in" and must not be treated as one. */
  async function session() {
    const s = await probeOnce();
    if (s) noteSuccess(); else noteFailure();
    return s;
  }

  /** Nothing can be shown but the reason: the app hasn't loaded a session, so
   * there's no UI to put a banner on top of. Polls until the server answers and
   * then simply starts over — a fresh boot is cheaper to reason about than
   * resuming a half-initialized one. */
  function showBootOffline() {
    const panel = $el('boot-offline');
    if (!panel) return;
    panel.hidden = false;
    $el('boot-offline-retry')?.addEventListener('click', () => {
      $el('boot-offline-retry').disabled = true;
      stopProbe();
      runProbe();
      setTimeout(() => { const b = $el('boot-offline-retry'); if (b) b.disabled = false; }, 1500);
    });
    onChange((up) => { if (up) location.reload(); });
    setReachable(false);
  }

  function onChange(fn) { listeners.push(fn); }

  function start() {
    if (started) return;
    started = true;
    // The browser's own signals are hints, not verdicts: 'offline' is
    // trustworthy (no radio, no server), 'online' only means the device has a
    // network again — whether the SERVER is back is a separate question, so it
    // triggers a probe rather than flipping the state directly.
    addEventListener('offline', () => setReachable(false));
    addEventListener('online', () => { probeDelay = PROBE_MIN_MS; runProbe(); });
    // Coming back from the background (locked phone, app switcher) is the other
    // moment a stale "offline" needs re-checking — a network change while
    // suspended often fires no event the page ever sees.
    addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && !reachable) { probeDelay = PROBE_MIN_MS; runProbe(); }
    });
    $el('offline-banner-retry')?.addEventListener('click', () => { probeDelay = PROBE_MIN_MS; runProbe(); });
    // The native Android shell calls this when the OS reports the network back
    // (MainActivity#triggerNetworkRestoreSync) — a WebView doesn't always fire
    // the JS 'online' event on its own. Every name the shell has ever used is
    // kept as an alias: __codexaNetworkRestore from the template this app was
    // built from, __hmailNetworkRestore from before the rename to Hmelj. An
    // APK built against an older name is still out there on someone's phone
    // talking to this server, and it costs one line each to keep it working.
    window.__hmeljNetworkRestore = () => { probeDelay = PROBE_MIN_MS; runProbe(); };
    window.__codexaNetworkRestore = window.__hmeljNetworkRestore;
    window.__hmailNetworkRestore = window.__hmeljNetworkRestore;
    window.__hmeljNetworkLost = () => setReachable(false);
    window.__hmailNetworkLost = window.__hmeljNetworkLost;
    if (!navigator.onLine) setReachable(false);
    render();
  }

  return { start, onChange, noteSuccess, noteFailure, session, showBootOffline, isOnline: () => reachable };
})();
if (typeof window !== 'undefined') window.Connection = Connection;
