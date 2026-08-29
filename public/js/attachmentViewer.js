// Hmelj — full-screen attachment viewer (images/video/PDF) with a top bar
// (filename, share, download, close), pinch/scroll-to-zoom + drag-to-pan for
// images, and a mobile-aware fallback: on a phone, anything that isn't an
// image or a video (PDF very much included) is handed to the operating system
// — "Open with…" in the Android app, a forced download in a mobile browser —
// instead of being rendered into a viewer that can't draw it.
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
  function triggerDownload(url, filename) {
    const cached = recall(url);
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
    const res = await fetch(url, { signal, credentials: 'same-origin' });
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
   *  it is played from the live URL and never becomes a Blob (see playVideo). */
  function render(body, objectUrl, kind, filename) {
    body.innerHTML = '';
    if (kind === 'image') {
      const img = document.createElement('img');
      img.src = objectUrl;
      img.className = 'attach-viewer-img';
      img.draggable = false;
      body.appendChild(img);
      makeZoomable(img);
    } else if (kind === 'pdf') {
      const embed = document.createElement('embed');
      embed.src = objectUrl;
      embed.type = 'application/pdf';
      embed.className = 'attach-viewer-pdf';
      body.appendChild(embed);
    } else {
      body.innerHTML = `<div class="attach-viewer-fallback"><div class="attach-viewer-fallback-icon">📎</div><p>${esc(filename)}</p></div>`;
    }
  }

  function kindOf(contentType) {
    const type = String(contentType || '').split(';')[0].trim().toLowerCase();
    if (type.startsWith('image/')) return 'image';
    if (type.startsWith('video/')) return 'video';
    if (type === 'application/pdf') return 'pdf';
    return 'other';
  }

  /** { url, filename, contentType } — url is the attachment's download route. */
  function open({ url, filename, contentType = '' }) {
    close();
    const kind = kindOf(contentType);

    // Neither PDFs nor arbitrary files render reliably on a phone — not in an
    // installed PWA, not in a mobile browser, and least of all inside the
    // Android app's WebView, which draws a PDF as a blank white page. Skip the
    // broken inline attempt entirely and let the OS pick an app for it.
    //
    // This used to also require isStandalonePWA(), which is exactly why the
    // Android app fell through to the broken path: a WebView is not an
    // installed PWA, so display-mode never reports standalone there.
    if (kind !== 'image' && kind !== 'video' && isMobile()) {
      handOffToOS(url, filename, contentType);
      return;
    }

    overlay = document.createElement('div');
    overlay.className = 'attach-viewer-backdrop';
    overlay.innerHTML = `
      <div class="attach-viewer-bar">
        <span class="attach-viewer-name">${esc(filename)}</span>
        <span class="spacer"></span>
        <button class="icon-btn" id="av-share" title="Share" hidden>⇧</button>
        <button class="icon-btn" id="av-download" title="Download">⬇</button>
        <button class="icon-btn" id="av-close" title="Close">✕</button>
      </div>
      <div class="attach-viewer-body"></div>`;
    document.body.appendChild(overlay);
    document.addEventListener('keydown', onKeydown);

    const body = overlay.querySelector('.attach-viewer-body');
    // Click outside the media itself (the empty backdrop/body area) closes.
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay || e.target === body) close(); });
    overlay.querySelector('#av-close').addEventListener('click', close);
    overlay.querySelector('#av-download').addEventListener('click', () => triggerDownload(url, filename));

    if (navigator.share && navigator.canShare) {
      const shareBtn = overlay.querySelector('#av-share');
      shareBtn.hidden = false;
      shareBtn.addEventListener('click', async () => {
        try {
          // Whatever the preview is already showing, not a second download of it.
          const blob = recall(url)?.blob || await fetch(url, { credentials: 'same-origin' }).then((r) => r.blob());
          const file = new File([blob], filename || 'attachment', { type: contentType || blob.type });
          if (navigator.canShare({ files: [file] })) await navigator.share({ files: [file] });
          else await navigator.share({ url });
        } catch { /* user cancelled, or sharing unsupported for this file — no-op */ }
      });
    }

    // Nothing here can draw it, so there is nothing to fetch: the paperclip
    // card and the bar's Download button are the whole offer, and pulling
    // twenty megabytes down to show an icon would be worse than useless.
    if (kind === 'other') { render(body, null, 'other', filename); return; }

    // Video is the one kind that must NOT wait for all of its bytes. A player
    // pointed straight at the URL starts as soon as enough has arrived and
    // shows its own buffering state in its own controls; buffering the whole
    // file into a Blob first would turn a video you can start watching into a
    // progress bar you have to sit through. The spinner over it is only for
    // the gap before the first frame, when the element is still a black box.
    if (kind === 'video') { playVideo(body, url, filename); return; }

    // Already fetched once this session: straight to the picture, no spinner,
    // no flash of an empty viewer.
    const cached = recall(url);
    if (cached) { render(body, cached.objectUrl, kind, filename); return; }

    load(body, url, filename, contentType, kind);
  }

  /** A player on the live URL, with the spinner left on top until it has
   *  something to show. Nothing is cached: the browser's media stack is
   *  already doing that, and far better than a Blob would. */
  function playVideo(body, url, filename) {
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
      body.querySelector('[data-av="retry"]')?.addEventListener('click', () => playVideo(body, url, filename));
      body.querySelector('[data-av="save"]')?.addEventListener('click', () => triggerDownload(url, filename));
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
      render(mine, entry.objectUrl, kind, filename);
    }).catch((e) => {
      if (controller.signal.aborted || inflight !== controller) return;
      inflight = null;
      mine.innerHTML = errorHtml(filename, e?.message || '');
      mine.querySelector('[data-av="retry"]')?.addEventListener('click',
        () => load(mine, url, filename, contentType, kind));
      mine.querySelector('[data-av="save"]')?.addEventListener('click',
        () => triggerDownload(url, filename));
    });
  }

  return { open, close, isOpen };
})();
if (typeof window !== 'undefined') window.AttachmentViewer = AttachmentViewer;
