// Hmelj — the browser half of OAuth2 sign-in (server side: server/oauth.js).
//
// All this does is get the user in front of the provider's real sign-in page
// and then wait for the server to tell it the tokens landed. It never sees a
// token itself — that is the entire point of doing the code exchange on the
// server.
//
// Why it can't be simpler: the sign-in page cannot be framed (Microsoft and
// Google both send X-Frame-Options / frame-ancestors), and it cannot run in an
// Android WebView either (Google answers 403 disallowed_useragent there, and
// this app's WebView has multiple-window support switched off, so window.open
// is silently inert). So there are three ways to get the page open, tried in
// order, and — crucially — the completion signal has to work even when the
// sign-in finished in a *different browser entirely*. That's why polling, not
// postMessage, is the load-bearing mechanism here.
const OAuthFlow = (() => {
  const POLL_MS = 1500;
  const TIMEOUT_MS = 10 * 60e3;

  const isAndroidApp = () => !!(window.AndroidApp || window.AndroidCodexa);
  const bridge = () => window.AndroidApp || window.AndroidCodexa;

  /**
   * Open the provider's sign-in page, returning how it was opened so the
   * caller can say something useful while it waits.
   *  'popup'    — desktop/PWA window.open; postMessage will hand back instantly
   *  'external' — Android Custom Tab, or a same-tab navigation the native shell
   *               punts to the system browser; only polling can finish this
   *  'manual'   — nothing could be opened automatically (popup blocked); the
   *               caller has to render a link for the user to tap
   */
  function openAuthWindow(authUrl) {
    // Android: hand off to a real browser. openExternal is a Custom Tab; older
    // APKs without it fall through to the same-tab navigation below, which
    // MainActivity's shouldOverrideUrlLoading already redirects to the system
    // browser because it's a different host — so old builds degrade instead of
    // dead-ending.
    if (isAndroidApp()) {
      try {
        if (typeof bridge().openExternal === 'function') {
          bridge().openExternal(authUrl);
          return { how: 'external' };
        }
      } catch { /* fall through to the manual link */ }
      return { how: 'manual', sameTab: true };
    }
    let w = null;
    try { w = window.open(authUrl, 'hmelj-oauth', 'width=520,height=700,menubar=no,toolbar=no'); } catch { w = null; }
    if (w) return { how: 'popup', win: w };
    return { how: 'manual', sameTab: false };
  }

  /**
   * Run one sign-in. Resolves { email } once the server holds the tokens for
   * this flow; the caller then passes `state` (also on the resolved object)
   * to the account save or to /api/oauth/attach.
   *
   * `onStatus(kind, detail)` is called with 'opening' | 'waiting' | 'manual',
   * so the wizard can show a link when the popup was blocked.
   */
  async function signIn({ provider, email, accountId = null, features = null, onStatus = () => {} }) {
    const { authUrl, state } = await API.oauthStart({ provider, email, accountId, features });
    onStatus('opening');
    const opened = openAuthWindow(authUrl);
    if (opened.how === 'manual') onStatus('manual', { authUrl, sameTab: opened.sameTab });
    else onStatus('waiting', { how: opened.how });

    return new Promise((resolve, reject) => {
      let done = false;
      const finish = (fn, arg) => {
        if (done) return;
        done = true;
        clearInterval(timer);
        clearTimeout(deadline);
        window.removeEventListener('message', onMessage);
        fn(arg);
      };

      // Latency shortcut only: same-origin message from the callback page when
      // it happens to be a popup we opened. Everything below still runs.
      const onMessage = (ev) => {
        if (ev.origin !== window.location.origin) return;
        if (ev.data?.type === 'hmelj-oauth-done' && ev.data.state === state) poll();
      };
      window.addEventListener('message', onMessage);

      let polling = false;
      const poll = async () => {
        if (polling || done) return;
        polling = true;
        try {
          const r = await API.oauthStatus(state);
          if (r.status === 'ok') finish(resolve, { email: r.email, state });
          else if (r.status === 'error') finish(reject, new Error(r.error || 'Sign-in failed'));
          else if (r.status === 'unknown') finish(reject, new Error(I18n.t('This sign-in expired. Please try again.')));
        } catch {
          // Offline, or the server restarted mid-flow — keep polling; the
          // deadline below is what eventually gives up.
        } finally {
          polling = false;
        }
      };

      const timer = setInterval(poll, POLL_MS);
      const deadline = setTimeout(
        () => finish(reject, new Error(I18n.t('Timed out waiting for sign-in.'))),
        TIMEOUT_MS
      );

      // A popup the user closed without finishing would otherwise leave the
      // wizard spinning for the full ten minutes.
      if (opened.how === 'popup') {
        const closedCheck = setInterval(() => {
          if (done) return clearInterval(closedCheck);
          if (opened.win.closed) {
            clearInterval(closedCheck);
            // One last poll: closing the window IS the normal ending, and the
            // result usually arrived a moment before it did.
            setTimeout(() => {
              poll().then(() => {
                if (!done) finish(reject, new Error(I18n.t('The sign-in window was closed before it finished.')));
              });
            }, 600);
          }
        }, 700);
      }
    });
  }

  return { signIn, isAndroidApp };
})();
