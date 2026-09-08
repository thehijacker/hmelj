// Hmelj — full-screen attachment viewer (images/video/PDF, Word and Excel)
// with a top bar (filename, share, download, close), pinch/scroll-to-zoom +
// drag-to-pan for images, and a mobile-aware fallback: on a phone, anything
// that isn't an image, a video or an Office document (PDF very much included)
// is handed to the operating system — "Open with…" in the Android app, a
// forced download in a mobile browser — instead of being rendered into a
// viewer that can't draw it. Office documents can be handed over too, but by
// choice, from a button, because a WebView renders their HTML perfectly well.
//
// Getting the bytes is not instant and cannot be made so: the server has to
// pull the whole message from the mail server to cut one part out of it (see
// the attachment routes in server/index.js). What used to happen meanwhile was
// the worst possible thing — the overlay went up black and empty and stayed
// that way for several seconds with nothing to say it was working. So the
// bytes are now fetched here rather than handed to `<img src>`, which buys
// three things at once: a real progress bar with a real total, a Cancel that
// actually cancels, and a Blob that Download and Share reuse instead of
// fetching the same attachment a second time.
const AttachmentViewer = (() => {
  let overlay = null;
  let inflight = null;   // AbortController for the fetch this overlay is waiting on

  function isMobile() {
    return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  }
  function esc(s) { const d = document.createElement('div'); d.textContent = s ?? ''; return d.innerHTML; }
  // esc() leaves a literal " alone — harmless in text, but it closes an
  // attribute early. Titles below come from translations, so they are not ours
  // to vouch for.
  function attr(s) { return esc(s).replace(/"/g, '&quot;'); }
  /** One icon from public/images, masked so it takes the bar's own colour — the
   *  same markup app.js#iconHtml produces. Repeated here rather than shared
   *  because message.html loads this file WITHOUT app.js, and a viewer whose
   *  buttons are blank in the standalone message window would be a poor trade
   *  for saving four lines. */
  function icon(name) {
    return `<span class="app-icon" style="--icon:url(/images/${name}.svg)" aria-hidden="true"></span>`;
  }
  function t(s) { return (typeof I18n !== 'undefined' && I18n.t) ? I18n.t(s) : s; }

  function fmtBytes(n) {
    if (!(n > 0)) return '';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
  }

  /* ---------- the bytes we already have ----------
   *
   * The server marks attachments immutable and cacheable, so the browser's own
   * HTTP cache does most of this work already. This sits in front of it for the
   * part that cache can't help with: re-opening an attachment must be INSTANT,
   * with no fetch to await and no frame where the viewer is empty again, and
   * Download/Share must not re-fetch bytes that are already in hand (the
   * Download button asks for a different URL — `?download=1` — so as far as the
   * HTTP cache is concerned it is a different resource entirely).
   *
   * Bounded by total bytes, because one video is worth a thousand thumbnails.
   * An evicted entry's object URL is revoked, or the tab would hold every
   * attachment ever opened until it was closed.
   */
  const blobs = new Map(); // url -> { blob, objectUrl, bytes }
  const MAX_BLOB_BYTES = 64 * 1024 * 1024;
  let blobBytes = 0;

  function remember(url, blob) {
    forget(url);
    const entry = { blob, objectUrl: URL.createObjectURL(blob), bytes: blob.size };
    blobs.set(url, entry);
    blobBytes += entry.bytes;
    for (const key of [...blobs.keys()]) {
      if (blobBytes <= MAX_BLOB_BYTES) break;
      if (key === url) continue;              // never evict the one being shown
      forget(key);
    }
    return entry;
  }
  function forget(url) {
    const e = blobs.get(url);
    if (!e) return;
    URL.revokeObjectURL(e.objectUrl);
    blobBytes -= e.bytes;
    blobs.delete(url);
  }
  function recall(url) {
    const e = blobs.get(url);
    if (!e) return null;
    blobs.delete(url);                        // re-insert: Map order is LRU order
    blobs.set(url, e);
    return e;
  }

  /** Same attachment URL, but asking the server for
   * `Content-Disposition: attachment` (see server/index.js) — without it a PDF
   * is served inline and a mobile browser tries to render it in-page instead of
   * handing it to the OS. */
  function downloadUrl(url) {
    return url + (url.includes('?') ? '&' : '?') + 'download=1';
  }

  /** Saves the file. Prefers bytes already fetched for the preview — that is
   *  the whole difference between "Download" being instant and it being the
   *  same multi-second wait a second time. `a.download` supplies the filename
   *  the Content-Disposition header would have. */
  async function triggerDownload(url, filename, contentType = '') {
    // The Android shell is the exception, and it fails SILENTLY otherwise: a
    // WebView's DownloadListener only ever sees a real navigation, so an anchor
    // pointed at a blob: URL — which is what the fast path below produces
    // whenever the preview has already fetched the bytes — clicks and does
    // nothing at all. Reported as "I tried to download the docx but it failed".
    // The shell's own hand-off re-fetches the server URL with the session
    // cookie and saves it properly, which is what Download means on a phone.
    //
    // Online only, and that is not a detail: handOffToOS's offline branch calls
    // straight back into this function, so taking this path while offline would
    // be an infinite bounce between the two.
    const bridge = window.AndroidApp || window.AndroidCodexa;
    if (bridge?.openAttachment && window.Connection?.isOnline?.() !== false) {
      handOffToOS(url, filename, contentType);
      return;
    }
    let cached = recall(url);
    // Offline, `downloadUrl(url)` is a navigation to a server that is not
    // there, which a browser answers with its own error page over the top of
    // the app. If this device saved the file, hand over those bytes instead.
    if (!cached && window.Connection?.isOnline?.() === false) {
      const saved = await offlineBytes(url);
      if (saved) cached = remember(url, saved.blob);
    }
    const a = document.createElement('a');
    a.href = cached ? cached.objectUrl : downloadUrl(url);
    a.download = filename || '';
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  /** Mobile: don't try to render it, hand it to the operating system.
   *
   * In the Android app the native shell does the real work — it re-fetches the
   * URL with the session cookie (HttpOnly, so JS can't pass it along) and fires
   * an "Open with…" chooser (MainActivity.kt#openAttachment). Everywhere else —
   * mobile browser, installed PWA — a plain forced download is the equivalent
   * hand-off: the browser saves it and the OS opens it with whatever the user
   * picks. An older APK without the bridge method falls through to the same
   * download path, where its new DownloadListener catches it.
   *
   * Always the server URL, never a blob: a blob: URL exists only inside this
   * page and means nothing to an Android intent. */
  function handOffToOS(url, filename, contentType) {
    // Offline there is no URL worth handing anywhere — the native shell would
    // re-fetch it and fail exactly as this page would. triggerDownload knows
    // how to serve the saved copy instead, and how to fall back to the ordinary
    // error if there isn't one.
    if (window.Connection?.isOnline?.() === false) { triggerDownload(url, filename); return; }
    const bridge = window.AndroidApp || window.AndroidCodexa;
    if (bridge?.openAttachment) {
      try {
        bridge.openAttachment(downloadUrl(new URL(url, location.href).href), filename || '', contentType || '');
        return;
      } catch { /* bridge threw — fall back to the browser path below */ }
    }
    const a = document.createElement('a');
    a.href = downloadUrl(url);
    a.download = filename || '';
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  function onKeydown(e) {
    if (e.key === 'Escape') close();
  }

  function close() {
    // Closing while it is still loading must actually stop the transfer, not
    // leave a few megabytes streaming into a viewer nobody is looking at.
    if (inflight) { inflight.abort(); inflight = null; }
    if (!overlay) return;
    overlay.remove();
    overlay = null;
    zoomTarget = null;   // the frame it pointed at just went with the overlay
    document.removeEventListener('keydown', onKeydown);
  }

  function isOpen() { return !!overlay; }

  function dist(t1, t2) {
    return Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
  }

  /** Mouse wheel / drag on desktop, pinch / drag on touch. */
  function makeZoomable(el) {
    let scale = 1;
    let panX = 0;
    let panY = 0;
    const apply = () => { el.style.transform = `translate(${panX}px, ${panY}px) scale(${scale})`; };

    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      scale = Math.min(5, Math.max(0.25, scale + (e.deltaY < 0 ? 0.15 : -0.15)));
      apply();
    }, { passive: false });

    let dragging = false, startX = 0, startY = 0;
    el.addEventListener('mousedown', (e) => {
      dragging = true; startX = e.clientX - panX; startY = e.clientY - panY;
      e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      panX = e.clientX - startX; panY = e.clientY - startY;
      apply();
    });
    window.addEventListener('mouseup', () => { dragging = false; });

    let pinchStartDist = null, pinchStartScale = 1;
    el.addEventListener('touchstart', (e) => {
      if (e.touches.length === 2) { pinchStartDist = dist(e.touches[0], e.touches[1]); pinchStartScale = scale; }
    }, { passive: true });
    el.addEventListener('touchmove', (e) => {
      if (e.touches.length === 2 && pinchStartDist) {
        scale = Math.min(5, Math.max(0.25, pinchStartScale * (dist(e.touches[0], e.touches[1]) / pinchStartDist)));
        apply();
      }
    }, { passive: true });
    el.addEventListener('touchend', (e) => { if (e.touches.length < 2) pinchStartDist = null; });
  }

  /* ---------- loading ---------- */

  /**
   * The saved copy of this attachment, if this device has one.
   *
   * Only files small enough to be worth keeping are ever saved, and only when
   * Settings › Offline is asked to keep attachments at all — so a miss here is
   * ordinary, not a failure, and the caller falls through to its normal "could
   * not load" card.
   */
  async function offlineBytes(url) {
    // The `download=1` variant names the same file — the offline store keys
    // on the message and the attachment index, and ignores the rest of the
    // query, so both spellings find the same bytes.
    const hit = await window.Offline?.attachment?.(url);
    return hit ? { blob: hit.blob, type: hit.type } : null;
  }

  /**
   * Fetches the attachment, reporting progress as it goes.
   *
   * Determinate whenever the server sent a Content-Length, which it now always
   * does for attachments — a bar that fills is the difference between "this is
   * working" and "this is broken". Where the body can't be streamed (an old
   * browser, or a response with no readable body) it still resolves correctly;
   * it just reports nothing on the way, and the caller shows the indeterminate
   * bar it started with.
   */
  async function fetchWithProgress(url, signal, onProgress) {
    // Nothing to try over the wire — go straight to what was saved, so a
    // deliberate offline open does not spend a timeout first.
    if (window.Connection?.isOnline?.() === false) {
      const saved = await offlineBytes(url);
      if (saved) return saved;
    }
    let res;
    try {
      res = await fetch(url, { signal, credentials: 'same-origin' });
    } catch (e) {
      // The connection went while this was in flight (or was never really
      // there). A saved copy is a better answer than the error.
      if (signal.aborted) throw e;
      const saved = await offlineBytes(url);
      if (saved) return saved;
      throw e;
    }
    // Every /api route answers a failure as {error}. Showing "HTTP 400" rather
    // than the sentence the server actually wrote is the difference between a
    // report that names the bug and one that needs the server log to decode.
    if (!res.ok) {
      const said = await res.json().then((j) => j?.error).catch(() => null);
      throw new Error(said || `HTTP ${res.status}`);
    }
    const total = Number(res.headers.get('Content-Length')) || 0;
    const type = res.headers.get('Content-Type') || '';
    if (!res.body || !res.body.getReader) return { blob: await res.blob(), type };

    const reader = res.body.getReader();
    const chunks = [];
    let loaded = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      loaded += value.length;
      onProgress(loaded, total);
    }
    return { blob: new Blob(chunks, { type }), type };
  }

  /** The panel shown while the bytes are on their way. */
  function loadingHtml(filename) {
    return `<div class="attach-viewer-status">
      <div class="attach-viewer-spinner"></div>
      <p class="attach-viewer-status-name">${esc(filename || '')}</p>
      <div class="attach-viewer-progress"><div class="attach-viewer-progress-fill attach-viewer-progress-idle"></div></div>
      <p class="attach-viewer-status-line">${esc(t('Loading…'))}</p>
    </div>`;
  }

  function errorHtml(filename, message) {
    return `<div class="attach-viewer-status">
      <div class="attach-viewer-fallback-icon">📎</div>
      <p class="attach-viewer-status-name">${esc(filename || '')}</p>
      <p class="attach-viewer-status-line">${esc(t('Could not load the attachment'))}${message ? ' — ' + esc(message) : ''}</p>
      <div class="attach-viewer-status-actions">
        <button class="btn-sm" data-av="retry">${esc(t('Retry'))}</button>
        <button class="btn-sm" data-av="save">${esc(t('Download'))}</button>
      </div>
    </div>`;
  }

/** Puts the fetched bytes on screen, by kind. Video is not among them —
   *  it is played from the live URL and never becomes a Blob (see playVideo).
   *  `entry` is the blob-cache entry: the object URL for the kinds a browser
   *  can draw by itself, the Blob itself for the ones a library has to parse. */
  function render(body, entry, kind, filename, url) {
    body.innerHTML = '';
    if (kind === 'image') {
      const img = document.createElement('img');
      img.src = entry.objectUrl;
      img.className = 'attach-viewer-img';
      img.draggable = false;
      body.appendChild(img);
      makeZoomable(img);
    } else if (kind === 'pdf') {
      const embed = document.createElement('embed');
      embed.src = entry.objectUrl;
      embed.type = 'application/pdf';
      embed.className = 'attach-viewer-pdf';
      body.appendChild(embed);
    } else if (kind === 'docx' || kind === 'sheet') {
      renderOffice(body, entry.blob, kind, filename, url);
    } else {
      body.innerHTML = `<div class="attach-viewer-fallback"><div class="attach-viewer-fallback-icon">📎</div><p>${esc(filename)}</p></div>`;
    }
  }

  /* ---------- what kind of thing is this ----------
   *
   * Content-Type alone is not enough for Office files. Plenty of mailers label
   * a .docx `application/octet-stream` — some label everything that way — so a
   * type-only test leaves the most common previewable attachment in the
   * "unknown, offer a download" bucket. The filename is the tie-breaker, and
   * only ever a tie-breaker: a real type always wins, so a .docx honestly
   * declared as something else is not overridden by its own extension.
   */
  const OFFICE_TYPES = {
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'application/msword': 'doc',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'sheet',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.template': 'sheet',
    'application/vnd.ms-excel': 'sheet',
    'application/vnd.ms-excel.sheet.macroenabled.12': 'sheet',
    'application/vnd.ms-excel.sheet.binary.macroenabled.12': 'sheet',
    'application/vnd.oasis.opendocument.spreadsheet': 'sheet',
    'text/csv': 'sheet',
  };
  // The spreadsheet family is one XLSX.read() call whatever the extension, so
  // leaving .xlsm or .ods out would be more code rather than less.
  const OFFICE_EXTS = {
    docx: 'docx', doc: 'doc',
    xlsx: 'sheet', xlsm: 'sheet', xlsb: 'sheet', xls: 'sheet', csv: 'sheet', ods: 'sheet',
  };
  /** Types that say "bytes", i.e. that tell us nothing and let the name speak. */
  const VAGUE = new Set(['', 'application/octet-stream', 'application/binary', 'binary/octet-stream']);

  function kindOf(contentType, filename) {
    const type = String(contentType || '').split(';')[0].trim().toLowerCase();
    if (type.startsWith('image/')) return 'image';
    if (type.startsWith('video/')) return 'video';
    if (type === 'application/pdf') return 'pdf';
    if (OFFICE_TYPES[type]) return OFFICE_TYPES[type];
    if (VAGUE.has(type)) {
      const ext = String(filename || '').split('.').pop().toLowerCase();
      if (OFFICE_EXTS[ext]) return OFFICE_EXTS[ext];
    }
    return 'other';
  }

  /** The three kinds this file renders itself, from a library and a blob. */
  function isOffice(kind) { return kind === 'docx' || kind === 'sheet' || kind === 'doc'; }

  /* ---------- Office documents ----------
   *
   * A .docx invoice or an .xlsx price list used to be the one common
   * attachment the viewer could say nothing at all about: a paperclip, a
   * filename, and a download you then had to open somewhere else. Both are
   * archives of XML, so both can be turned into HTML in the browser — no
   * conversion service, no bytes leaving the instance, and the same blob the
   * progress bar already fetched.
   *
   * The libraries are vendored under /vendor (see its README for why they are
   * not on a CDN) and are loaded ON DEMAND — SheetJS alone is most of a
   * megabyte, and most attachments are not spreadsheets. The service worker
   * runtime-caches them on first use, so the second preview works offline.
   */
  const VENDOR = {
    jszip: '/vendor/jszip-3.10.1.min.js',        // docx-preview's zip reader
    docx: '/vendor/docx-preview-0.4.0.min.js',
    xlsx: '/vendor/xlsx-0.20.3.full.min.js',
  };

  /** Loads a script once, whatever the number of callers. A rejected load is
   *  forgotten, so the error panel's Retry gets a real second attempt rather
   *  than the first failure handed back to it. */
  const scripts = new Map();
  function ensureScript(src) {
    if (scripts.has(src)) return scripts.get(src);
    const p = new Promise((resolve, reject) => {
      const el = document.createElement('script');
      el.src = src;
      el.async = true;
      el.addEventListener('load', () => resolve());
      el.addEventListener('error', () => {
        scripts.delete(src);
        el.remove();
        reject(new Error(t('Could not load the preview library')));
      });
      document.head.appendChild(el);
    });
    scripts.set(src, p);
    return p;
  }

  /* The rendered document is somebody else's HTML and CSS, arriving by email, so
     it goes into a srcdoc iframe with **no allow-same-origin**: an opaque origin
     cannot read this page, its cookies, or anything else on this server. Word's
     own styles cannot escape it either. `allow-popups` and the <base> are what
     keep a link in the document clickable.
     `allow-scripts` IS granted, for one reason: events inside a frame never
     reach its parent, so without a script in there Ctrl+wheel and pinch over the
     document could not zoom it — the pointer is over the frame, and the frame is
     where the event stops. The only script that should be in there is
     FRAME_EVENTS below, which is why the document is stripped of active
     content first (see stripActiveContent) and rendered with renderAltChunks
     off. Scripts plus an opaque origin is the same posture the message reading
     pane has used all along (messageFrame.js). */
  const FRAME_SANDBOX = 'allow-scripts allow-popups allow-popups-to-escape-sandbox';

  /**
   * The gestures a frame has to hand outwards, because a frame is where they
   * stop: Ctrl/⌘+wheel and two-finger pinch (zoom), and Escape (close).
   *
   * Escape matters more than it looks. The document-level handler in this file
   * catches it fine — right up until somebody clicks into the document, at
   * which point the keystroke belongs to the frame and the page around it never
   * hears about it. That is precisely when a reader wants out.
   *
   * Nothing crosses this channel but an intent: a direction, or "close". The
   * parent decides what either means, so the most a hostile frame could do with
   * it is resize or dismiss itself.
   */
  const FRAME_EVENTS = `
    (function () {
      var send = function (m) { parent.postMessage(m, '*'); };
      addEventListener('keydown', function (e) {
        if (e.key === 'Escape') { e.preventDefault(); send({ hmeljClose: 1 }); }
      });
      var zoom = function (dir) { send({ hmeljZoom: dir }); };
      addEventListener('wheel', function (e) {
        if (!e.ctrlKey && !e.metaKey) return;
        e.preventDefault();
        zoom(e.deltaY < 0 ? 1 : -1);
      }, { passive: false });
      var start = null;
      var gap = function (t) { return Math.hypot(t[1].clientX - t[0].clientX, t[1].clientY - t[0].clientY); };
      addEventListener('touchstart', function (e) { if (e.touches.length === 2) start = gap(e.touches); }, { passive: true });
      addEventListener('touchmove', function (e) {
        if (e.touches.length !== 2 || !start) return;
        var now = gap(e.touches);
        // A threshold, not every pixel: the parent's step is 10% and firing one
        // per frame would take the zoom from 100% to 300% in half a swipe.
        if (Math.abs(now - start) < 28) return;
        zoom(now > start ? 1 : -1);
        start = now;
      }, { passive: true });
      addEventListener('touchend', function (e) { if (e.touches.length < 2) start = null; });
    })();`;

  /**
   * Everything in a rendered document that could execute, removed.
   *
   * The frame runs scripts now (see FRAME_SANDBOX), so "the docx cannot bring
   * its own" has to be true rather than assumed. Two things could carry one: an
   * altChunk (a raw HTML part embedded in the docx — turned off at the renderer
   * instead, since it is content rather than markup), and an event-handler
   * attribute or javascript: URL surviving out of the document's own XML.
   *
   * Works on the DETACHED tree, before it is ever serialised into the frame.
   */
  function stripActiveContent(root) {
    root.querySelectorAll('script, iframe, object, embed, link, meta, base, form').forEach((n) => n.remove());
    for (const el of root.querySelectorAll('*')) {
      for (const a of [...el.attributes]) {
        if (/^on/i.test(a.name)) el.removeAttribute(a.name);
        else if (/^(href|src|xlink:href)$/i.test(a.name) && /^\s*javascript:/i.test(a.value)) el.removeAttribute(a.name);
      }
    }
    return root;
  }

  function frameDoc(css, bodyHtml, { zoomable = false } = {}) {
    return `<!doctype html><html><head><meta charset="utf-8">`
      + `<meta name="viewport" content="width=device-width, initial-scale=1">`
      + `<base target="_blank"><style>${css}</style></head><body>${bodyHtml}`
      + (zoomable ? `<script>${FRAME_EVENTS}<\/script>` : '')
      + `</body></html>`;
  }

  const DOC_BASE_CSS = `
    html, body { margin: 0; padding: 0; background: #eceff1; color: #202124;
      font: 14px/1.5 -apple-system, "Segoe UI", Roboto, Arial, sans-serif;
      /* Scrolling stays the browser's; pinching becomes ours (FRAME_EVENTS),
         which zooms the whole frame from outside rather than the browser's own
         zoom of the frame's contents — the two fighting over the same gesture
         is how a document ends up at two different scales at once. */
      touch-action: pan-x pan-y; }
    .av-note { margin: 0; padding: 8px 14px; background: #fff8e1; color: #5f4b00;
      border-bottom: 1px solid #f0e0a8; font-size: 12px; position: sticky; top: 0; z-index: 2; }`;

  const SHEET_CSS = `${DOC_BASE_CSS}
    body { background: #fff; }
    /* The column letters are the thing that has to stay in view here, and two
       stickies at top: 0 would sit on top of each other. */
    .av-note { position: static; }
    table { border-collapse: separate; border-spacing: 0; font-size: 13px; }
    th, td { border-right: 1px solid #e0e0e0; border-bottom: 1px solid #e0e0e0;
      padding: 3px 8px; white-space: pre; max-width: 340px; overflow: hidden;
      text-overflow: ellipsis; vertical-align: top; }
    /* Row numbers and column letters stay put while the sheet scrolls under
       them — without that, ten columns in, nothing on screen says which
       column or row you are looking at. */
    thead th { position: sticky; top: 0; z-index: 2; }
    th { background: #f1f3f4; color: #5f6368; font-weight: 500; text-align: center; }
    tbody th { position: sticky; left: 0; z-index: 1; text-align: right;
      font-variant-numeric: tabular-nums; }
    thead th:first-child { z-index: 3; left: 0; }
    td.num { text-align: right; font-variant-numeric: tabular-nums; }
    .av-empty { padding: 24px; color: #5f6368; }`;

  const TEXT_CSS = `${DOC_BASE_CSS}
    body { background: #fff; }
    pre { margin: 0; padding: 18px 22px; white-space: pre-wrap; word-wrap: break-word;
      font: 13px/1.6 ui-monospace, "SF Mono", Menlo, Consolas, monospace; }`;

  /* ---------- zoom, for the two kinds that are laid out rather than fitted ----------
   *
   * Applied to the iframe from OUT HERE — a transform on the element plus a
   * compensating size, so the frame still fills its box at any scale. Doing it
   * inside the document would mean rewriting the srcdoc on every click, which
   * reloads the frame and throws away the scroll position, and would need
   * scripting in a frame that deliberately has none.
   */
  let zoom = 1;
  let zoomTarget = null;

  function applyZoom() {
    if (zoomTarget) {
      zoomTarget.style.width = `${100 / zoom}%`;
      zoomTarget.style.height = `${100 / zoom}%`;
      zoomTarget.style.transform = `scale(${zoom})`;
    }
    const label = overlay?.querySelector('#av-zoom-level');
    if (label) label.textContent = `${Math.round(zoom * 100)}%`;
  }
  function setZoom(z) {
    zoom = Math.min(3, Math.max(0.4, Math.round(z * 20) / 20));
    applyZoom();
  }

  /* The frame asking to be zoomed. Registered once, not per document, and it
     answers only the frame currently on screen — `source` is the only thing
     worth checking here, since an opaque origin reports its origin as "null"
     and comparing that would accept every sandboxed frame on the page. */
  if (typeof window !== 'undefined') {
    window.addEventListener('message', (e) => {
      if (!zoomTarget || e.source !== zoomTarget.contentWindow) return;
      if (e.data?.hmeljClose) { close(); return; }
      const dir = e.data?.hmeljZoom;
      if (dir !== 1 && dir !== -1) return;
      setZoom(zoom + dir * 0.1);
    });
  }

  /** Frame + optional sheet tabs, in place of whatever the body was showing. */
  function officeShell(body, srcdoc, tabsHtml = '') {
    body.innerHTML = `<div class="attach-viewer-doc-shell">${tabsHtml}`
      + `<div class="attach-viewer-doc-wrap">`
      + `<iframe class="attach-viewer-doc" sandbox="${FRAME_SANDBOX}"></iframe>`
      + `</div></div>`;
    const frame = body.querySelector('.attach-viewer-doc');
    frame.srcdoc = srcdoc;
    zoomTarget = frame;
    applyZoom();
    return frame;
  }

  /** Is the viewer itself narrow — a phone, or a very small window? Asked of the
   *  VIEWPORT rather than the user agent: what a page of A4 does here is a
   *  question about pixels, not about which device is holding them. Same 900px
   *  the app's own layout breaks at. */
  function isNarrowViewport() {
    return window.matchMedia?.('(max-width: 900px)').matches ?? (window.innerWidth <= 900);
  }

  /* docx-preview's own stylesheet centres the page inside its wrapper
     (`.docx-wrapper { align-items: center }`). When the page is WIDER than the
     frame — always, on a phone: A4 is ~816px against ~380 — a centred flex item
     overflows equally at both ends, and the left overflow cannot be scrolled
     to. That is the "half the text was missing on the left" report: the words
     were there, just at a negative offset with no way to reach them.
     `body >` to outrank it: docx-preview's styles are spliced into the BODY, so
     they come after this and win on equal specificity.

     flex-start plus AUTO MARGINS rather than `center`, because those two differ
     in exactly the case that matters: an auto margin gives up and resolves to
     zero when there is no room, so a page narrower than the frame is centred in
     the grey exactly as it should be, and a wider one starts at the left edge
     where it can actually be scrolled to. (`align-items: safe center` says the
     same thing in one word, but silently drops the whole declaration on a
     browser that does not know it — and dropping it restores the bug.) */
  const DOCX_WIDE_CSS = `
    body > .docx-wrapper { align-items: flex-start; }
    body > .docx-wrapper > section.docx { margin-left: auto; margin-right: auto; }`;

  /* On a narrow screen, don't make it scrollable — make it fit. The page is
     rendered without its fixed width (see ignoreWidth below) so the text
     reflows to the frame, and the page's own margins are cut back: a 2.5cm
     Word margin is 94px at each edge, which on a 380px phone leaves under half
     the width for the words. !important because docx-preview writes the page
     geometry as INLINE styles on the section, which a stylesheet cannot
     otherwise reach. */
  const DOCX_NARROW_CSS = `
    body > .docx-wrapper { align-items: stretch; padding: 8px; }
    body section.docx {
      width: auto !important; min-width: 0 !important; max-width: 100% !important;
      padding-left: 12px !important; padding-right: 12px !important;
    }
    body section.docx img, body section.docx table { max-width: 100% !important; height: auto; }`;

  /** .docx → HTML, with its page layout, tables and embedded images intact. */
  async function renderDocx(body, blob) {
    await ensureScript(VENDOR.jszip);
    await ensureScript(VENDOR.docx);
    // Two DETACHED containers: docx-preview writes the document's own <style>
    // rules into the second one, and a style element that is never connected
    // to this page can never restyle it. Both are read back as strings and
    // handed to the frame, so nothing the file brought with it is ever live
    // in the app's own document.
    const bodyEl = document.createElement('div');
    const styleEl = document.createElement('div');
    const narrow = isNarrowViewport();
    await window.docx.renderAsync(blob, bodyEl, styleEl, {
      className: 'docx',
      inWrapper: true,
      // Not the default (an object URL): those are minted against THIS page's
      // origin, and the frame below has an opaque one, so every embedded image
      // would come out blank — silently, which is the worst way for it to
      // fail. Base64 travels into the srcdoc with the markup.
      useBase64URL: true,
      // A phone cannot show a page of A4 at its real width, and a preview you
      // have to pan sideways to read a line of is not a preview. Dropping the
      // page geometry lets the text reflow to the screen; the desktop keeps the
      // document looking like the document.
      ignoreWidth: narrow,
      ignoreHeight: narrow,
      experimental: false,
      renderComments: false,
      renderChanges: false,
      // An altChunk is a raw HTML part embedded in the docx, rendered verbatim —
      // the one route by which an author's own markup, scripts included, could
      // reach the frame. Off, because the frame runs scripts now (see
      // FRAME_SANDBOX). Rare in practice: it is what some export tools emit.
      renderAltChunks: false,
    });
    if (!isCurrent(body)) return;
    stripActiveContent(bodyEl);
    stripActiveContent(styleEl);
    officeShell(body, frameDoc(DOC_BASE_CSS + (narrow ? DOCX_NARROW_CSS : DOCX_WIDE_CSS),
      styleEl.innerHTML + bodyEl.innerHTML, { zoomable: true }));
  }

  /* A preview, not a spreadsheet application: no formulas, no styling, no
     merged-cell geometry — the values as Excel formats them, in a grid you can
     read. The caps are what stop a 300,000-row export from building a
     multi-megabyte string and freezing the tab; what is cut is said out loud
     rather than quietly dropped. */
  const SHEET_MAX_ROWS = 5000;
  const SHEET_MAX_COLS = 200;
  const SHEET_MAX_CELLS = 150000;

  /** One cell as Excel shows it: `w` is the formatted text — 1.234,50 €,
   *  31/12/2026, 15% — and printing `v` instead would show the raw number
   *  under all three. `w` is only ever missing when the cell carries no format
   *  at all, which for a date would mean "Mon Sep 07 2026 02:00:00 GMT+0200". */
  function cellText(cell) {
    if (cell.w != null) return cell.w;
    if (cell.v == null) return '';
    if (cell.t === 'd' && cell.v instanceof Date) return cell.v.toLocaleDateString();
    return String(cell.v);
  }

  function sheetHtml(ws) {
    const XLSX = window.XLSX;
    if (!ws || !ws['!ref']) return `<p class="av-empty">${esc(t('This sheet is empty'))}</p>`;
    const r = XLSX.utils.decode_range(ws['!ref']);
    const endC = Math.min(r.e.c, r.s.c + SHEET_MAX_COLS - 1);
    const cols = endC - r.s.c + 1;
    const endR = Math.min(r.e.r, r.s.r + Math.max(1, Math.min(SHEET_MAX_ROWS, Math.floor(SHEET_MAX_CELLS / cols))) - 1);

    const out = ['<table><thead><tr><th></th>'];
    for (let c = r.s.c; c <= endC; c++) out.push(`<th>${XLSX.utils.encode_col(c)}</th>`);
    out.push('</tr></thead><tbody>');
    for (let row = r.s.r; row <= endR; row++) {
      out.push(`<tr><th>${row + 1}</th>`);
      for (let c = r.s.c; c <= endC; c++) {
        const cell = ws[XLSX.utils.encode_cell({ r: row, c })];
        out.push(`<td${cell && (cell.t === 'n' || cell.t === 'd') ? ' class="num"' : ''}>${cell ? esc(cellText(cell)) : ''}</td>`);
      }
      out.push('</tr>');
    }
    out.push('</tbody></table>');

    const cut = [];
    if (endR < r.e.r) cut.push(t('the first {n} rows of {total}').replace('{n}', endR - r.s.r + 1).replace('{total}', r.e.r - r.s.r + 1));
    if (endC < r.e.c) cut.push(t('the first {n} columns of {total}').replace('{n}', cols).replace('{total}', r.e.c - r.s.c + 1));
    const note = cut.length
      ? `<p class="av-note">${esc(t('Large sheet — showing {what}.').replace('{what}', cut.join(t(' and '))))}</p>`
      : '';
    return note + out.join('');
  }

  /** .xlsx/.xlsm/.xlsb/.xls/.csv/.ods — one read, one tab per sheet. */
  async function renderSheet(body, blob) {
    await ensureScript(VENDOR.xlsx);
    const wb = window.XLSX.read(new Uint8Array(await blob.arrayBuffer()), {
      type: 'array', cellDates: true, cellStyles: false,
    });
    if (!isCurrent(body)) return;
    const names = (wb.SheetNames || []).filter((n) => wb.Sheets[n]);
    if (!names.length) throw new Error(t('This workbook has no sheets'));

    let active = 0;
    const draw = () => {
      // One tab is not a choice, so it gets no tab strip — the filename in the
      // bar above already says what this is.
      const tabs = names.length > 1
        ? `<div class="attach-viewer-sheet-tabs">${names.map((n, i) =>
          `<button class="attach-viewer-sheet-tab${i === active ? ' is-active' : ''}" data-sheet="${i}">${esc(n)}</button>`).join('')}</div>`
        : '';
      officeShell(body, frameDoc(SHEET_CSS, sheetHtml(wb.Sheets[names[active]]), { zoomable: true }), tabs);
      body.querySelectorAll('[data-sheet]').forEach((b) => b.addEventListener('click', () => {
        active = Number(b.dataset.sheet);
        draw();
      }));
    };
    draw();
  }

  /** The attachment's text route — `/text` before the query, which carries the
   *  account the rest of the URL was built with (see API.attachmentUrl). */
  function textUrl(url) {
    const q = url.indexOf('?');
    return q === -1 ? `${url}/text` : `${url.slice(0, q)}/text${url.slice(q)}`;
  }

  /**
   * Legacy .doc, as text.
   *
   * A Word 97–2003 file is an OLE compound document, not a zip of XML, and
   * there is no light way to render one faithfully in a browser — the honest
   * options are a text extraction or half a gigabyte of LibreOffice in the
   * image. So the server extracts the text (see the /text route in
   * server/index.js) and the note above it says plainly what is missing,
   * rather than letting a plain-looking preview pass itself off as the
   * document.
   */
  function loadDocText(body, url, filename) {
    body.innerHTML = loadingHtml(filename);
    const controller = new AbortController();
    inflight = controller;
    const mine = body;
    fetch(textUrl(url), { credentials: 'same-origin', signal: controller.signal })
      .then(async (res) => {
        const data = await res.json().catch(() => null);
        if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
        return data || {};
      })
      .then((data) => {
        if (inflight !== controller) return;
        inflight = null;
        const text = data.text || '';
        // A .doc whose content is one big embedded object — a scanned page, a
        // pasted spreadsheet — extracts to nothing at all. Saying so beats an
        // empty white frame that looks like a failed render.
        const note = text
          ? t('Word 97–2003 document — shown as text, without its formatting.')
            + (data.truncated ? ` ${t('It is long, so only the first part is shown.')}` : '')
          : t('No text could be read from this document — it may be all images. Download it to open it in Word.');
        officeShell(mine, frameDoc(TEXT_CSS,
          `<p class="av-note">${esc(note)}</p><pre>${esc(text)}</pre>`));
      })
      .catch((e) => {
        if (controller.signal.aborted || inflight !== controller) return;
        inflight = null;
        showError(mine, filename, e?.message || '', () => loadDocText(mine, url, filename), url);
      });
  }

  /** Still the body of the overlay that asked for this? An open() while a
   *  library or a parse was in flight must not have its viewer overwritten by
   *  the previous file finishing. */
  function isCurrent(body) {
    return overlay?.querySelector('.attach-viewer-body') === body;
  }

  /** The error panel, with its two buttons wired. */
  function showError(body, filename, message, retry, url, contentType = '') {
    body.innerHTML = errorHtml(filename, message);
    body.querySelector('[data-av="retry"]')?.addEventListener('click', retry);
    body.querySelector('[data-av="save"]')?.addEventListener('click', () => triggerDownload(url, filename, contentType));
  }

  /** Bytes in hand → a document on screen. Both renderers have to load a
   *  library and parse a whole file first, so the loading panel stays up until
   *  one of them has something to show. */
  function renderOffice(body, blob, kind, filename, url) {
    body.innerHTML = loadingHtml(filename);
    const line = body.querySelector('.attach-viewer-status-line');
    if (line) line.textContent = t('Preparing the preview…');
    const mine = body;
    const done = kind === 'docx' ? renderDocx(mine, blob) : renderSheet(mine, blob);
    done.catch((e) => {
      if (!isCurrent(mine)) return;
      showError(mine, filename, e?.message || '', () => renderOffice(mine, blob, kind, filename, url), url);
    });
  }

  /** { url, filename, contentType } — url is the attachment's download route. */
  function open({ url, filename, contentType = '' }) {
    close();
    const kind = kindOf(contentType, filename);
    zoom = 1;
    zoomTarget = null;

    // Neither PDFs nor arbitrary files render reliably on a phone — not in an
    // installed PWA, not in a mobile browser, and least of all inside the
    // Android app's WebView, which draws a PDF as a blank white page. Skip the
    // broken inline attempt entirely and let the OS pick an app for it.
    //
    // This used to also require isStandalonePWA(), which is exactly why the
    // Android app fell through to the broken path: a WebView is not an
    // installed PWA, so display-mode never reports standalone there.
    //
    // Office documents are the exception among the non-media kinds: what the
    // renderers below produce is ordinary HTML, which a WebView draws as well
    // as any browser. They stay in the app — and keep the hand-off too, as a
    // button (see #av-openwith), because a spreadsheet you actually mean to
    // work on still belongs in a spreadsheet app.
    if (kind !== 'image' && kind !== 'video' && !isOffice(kind) && isMobile()) {
      handOffToOS(url, filename, contentType);
      return;
    }

    overlay = document.createElement('div');
    overlay.className = 'attach-viewer-backdrop';
    overlay.innerHTML = `
      <div class="attach-viewer-bar">
        <span class="attach-viewer-name">${esc(filename)}</span>
        <span class="spacer"></span>
        <span class="attach-viewer-zoom" id="av-zoom" hidden>
          <button class="icon-btn" id="av-zoom-out" title="${attr(t('Zoom out'))}">−</button>
          <button class="attach-viewer-zoom-level" id="av-zoom-level" title="${attr(t('Reset zoom'))}">100%</button>
          <button class="icon-btn" id="av-zoom-in" title="${attr(t('Zoom in'))}">+</button>
        </span>
        <button class="icon-btn" id="av-openwith" title="${attr(t('Open with another app'))}" hidden>${icon('open-with')}</button>
        <button class="icon-btn" id="av-share" title="Share" hidden>⇧</button>
        <button class="icon-btn" id="av-download" title="Download">${icon('download')}</button>
        <button class="icon-btn" id="av-close" title="Close">✕</button>
      </div>
      <div class="attach-viewer-body"></div>`;
    document.body.appendChild(overlay);
    document.addEventListener('keydown', onKeydown);

    const body = overlay.querySelector('.attach-viewer-body');
    // Click outside the media itself (the empty backdrop/body area) closes.
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay || e.target === body) close(); });
    overlay.querySelector('#av-close').addEventListener('click', close);
    overlay.querySelector('#av-download').addEventListener('click', () => triggerDownload(url, filename, contentType));

    // A Word page and a spreadsheet are laid out to a width of their own
    // rather than fitted to the screen, so they are the two that need a zoom.
    // An image already has pinch and wheel (makeZoomable); a PDF has the
    // viewer's own controls.
    if (kind === 'docx' || kind === 'sheet') {
      overlay.querySelector('#av-zoom').hidden = false;
      overlay.querySelector('#av-zoom-out').addEventListener('click', () => setZoom(zoom - 0.1));
      overlay.querySelector('#av-zoom-in').addEventListener('click', () => setZoom(zoom + 0.1));
      overlay.querySelector('#av-zoom-level').addEventListener('click', () => setZoom(1));
    }

    // The hand-off this file used to get automatically on a phone, kept as a
    // choice now that there is a preview to choose it from: the Android
    // shell's "Open with…" chooser, a forced download everywhere else.
    if (isOffice(kind) && isMobile()) {
      const openWith = overlay.querySelector('#av-openwith');
      openWith.hidden = false;
      openWith.addEventListener('click', () => handOffToOS(url, filename, contentType));
      // …and then Download is the same button twice. In the Android shell a
      // download IS this hand-off (see triggerDownload: a WebView cannot save a
      // blob: URL, so it routes through the bridge, which saves the file and
      // then offers to open it). Two buttons doing one thing is worse than one.
      if (window.AndroidApp?.openAttachment || window.AndroidCodexa?.openAttachment) {
        overlay.querySelector('#av-download').hidden = true;
      }
    }

    if (navigator.share && navigator.canShare) {
      const shareBtn = overlay.querySelector('#av-share');
      shareBtn.hidden = false;
      shareBtn.addEventListener('click', async () => {
        try {
          // Whatever the preview is already showing, not a second download of
          // it — then the saved copy, then the network.
          const blob = recall(url)?.blob
            || (await offlineBytes(url))?.blob
            || await fetch(url, { credentials: 'same-origin' }).then((r) => r.blob());
          const file = new File([blob], filename || 'attachment', { type: contentType || blob.type });
          if (navigator.canShare({ files: [file] })) await navigator.share({ files: [file] });
          else await navigator.share({ url });
        } catch { /* user cancelled, or sharing unsupported for this file — no-op */ }
      });
    }

    // Nothing here can draw it, so there is nothing to fetch: the paperclip
    // card and the bar's Download button are the whole offer, and pulling
    // twenty megabytes down to show an icon would be worse than useless.
    if (kind === 'other') { render(body, null, 'other', filename, url); return; }

    // Legacy .doc is the one previewable kind whose bytes are of no use here:
    // it is an OLE compound document, and what comes back from the server is
    // the text pulled out of it, not the file.
    if (kind === 'doc') { loadDocText(body, url, filename); return; }

    // Video is the one kind that must NOT wait for all of its bytes. A player
    // pointed straight at the URL starts as soon as enough has arrived and
    // shows its own buffering state in its own controls; buffering the whole
    // file into a Blob first would turn a video you can start watching into a
    // progress bar you have to sit through. The spinner over it is only for
    // the gap before the first frame, when the element is still a black box.
    if (kind === 'video') { playVideo(body, url, filename, contentType); return; }

    // Already fetched once this session: straight to the picture, no spinner,
    // no flash of an empty viewer.
    const cached = recall(url);
    if (cached) { render(body, cached, kind, filename, url); return; }

    load(body, url, filename, contentType, kind);
  }

  /** A player on the live URL, with the spinner left on top until it has
   *  something to show. Nothing is cached: the browser's media stack is
   *  already doing that, and far better than a Blob would. */
  function playVideo(body, url, filename, contentType = '') {
    body.innerHTML = loadingHtml(filename);
    // Over the player, not beside it: this one is a sibling of the <video>,
    // where every other use of the panel is the only thing in the body.
    body.querySelector('.attach-viewer-status')?.classList.add('attach-viewer-status-over');
    const video = document.createElement('video');
    video.src = url;
    video.controls = true;
    video.className = 'attach-viewer-video';
    video.addEventListener('loadeddata', () => { body.querySelector('.attach-viewer-status')?.remove(); });
    video.addEventListener('error', () => {
      body.innerHTML = errorHtml(filename, '');
      body.querySelector('[data-av="retry"]')?.addEventListener('click', () => playVideo(body, url, filename, contentType));
      body.querySelector('[data-av="save"]')?.addEventListener('click', () => triggerDownload(url, filename, contentType));
    });
    body.appendChild(video);
  }

  /** One attempt at fetching and showing it. Re-entrant: the error panel's
   *  Retry calls straight back into this with the same arguments. */
  function load(body, url, filename, contentType, kind) {
    body.innerHTML = loadingHtml(filename);
    const fill = body.querySelector('.attach-viewer-progress-fill');
    const line = body.querySelector('.attach-viewer-status-line');
    const controller = new AbortController();
    inflight = controller;
    const mine = body;

    const onProgress = (loaded, total) => {
      if (overlay?.querySelector('.attach-viewer-body') !== mine) return;
      if (total > 0) {
        fill.classList.remove('attach-viewer-progress-idle');
        fill.style.width = `${Math.min(100, Math.round((loaded / total) * 100))}%`;
        line.textContent = `${fmtBytes(loaded)} / ${fmtBytes(total)}`;
      } else {
        line.textContent = fmtBytes(loaded);
      }
    };

    fetchWithProgress(url, controller.signal, onProgress).then(({ blob }) => {
      if (inflight !== controller) return;          // closed, or superseded by another open()
      inflight = null;
      const entry = remember(url, blob);
      render(mine, entry, kind, filename, url);
    }).catch((e) => {
      if (controller.signal.aborted || inflight !== controller) return;
      inflight = null;
      mine.innerHTML = errorHtml(filename, e?.message || '');
      mine.querySelector('[data-av="retry"]')?.addEventListener('click',
        () => load(mine, url, filename, contentType, kind));
      mine.querySelector('[data-av="save"]')?.addEventListener('click',
        () => triggerDownload(url, filename, contentType));
    });
  }

  return { open, close, isOpen };
})();
if (typeof window !== 'undefined') window.AttachmentViewer = AttachmentViewer;
