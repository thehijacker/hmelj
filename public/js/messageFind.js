// Hmelj — find-in-message: the floating search bar over the reading pane
// (Ctrl+F, or "Search in message" in a message's ⋯ menu).
//
// Why the work is split across two files: the message body lives in a
// sandboxed iframe with no allow-same-origin (messageFrame.js#create), so
// nothing here can read — let alone highlight — a single character of it. The
// text search and the highlighting therefore run inside the frame, and this
// file owns the UI, the keyboard, and the scrolling. They talk over the same
// postMessage channel the pan/resize/link handling already uses.
//
// Scrolling is this side's job for a structural reason: the frame is always
// exactly as tall as its content (it reports its height and the parent sizes
// it), so it never scrolls vertically — the reading pane does. That split is
// also what makes the bar's one hard promise keepable: since we do the
// scrolling and we know where the bar is, a hit is always parked BELOW the
// bar rather than behind it.
//
// Loaded by index.html and message.html alike — the popout renders the same
// MessageFrame, so it gets the same search with no extra wiring.
const MessageFind = (() => {
  const t = (s) => (window.I18n ? I18n.t(s) : s);

  let bar = null;          // the floating panel, or null when closed
  let frame = null;        // the iframe.mv-body-frame being searched
  let token = 0;           // request id; a reply carrying an older one is stale
  let count = 0, index = -1;
  let debounce = null;
  let ro = null;           // ResizeObserver on the scroll area, for repositioning

  function isOpen() { return !!bar; }

  /** The message body frame to search.
   *
   *  Usually the only one on screen — but a conversation opens several message
   *  bodies stacked in one pane (app.js#openThread), and there "the message"
   *  means the one being read: the topmost frame that is still visible, which
   *  is what scrolling to a message leaves at the top of the pane. */
  function currentFrame() {
    const frames = [...document.querySelectorAll('iframe.mv-body-frame')];
    if (frames.length < 2) return frames[0] || null;
    const top = frames.find((f) => f.getBoundingClientRect().bottom > 80);
    return top || frames[frames.length - 1];
  }

  /** Where the message actually sits on screen — both the band the bar is
   *  pinned to and the band a hit has to end up inside.
   *
   *  Two lookups, because the two windows are built differently. The main app
   *  has a .reading-pane that is itself the scroll box, so it defines both
   *  axes. The popout scrolls the whole page and has no pane at all: the
   *  vertical band is simply the viewport, while the horizontal edges still
   *  come from the centred .message-view column so the bar tracks the text
   *  rather than the window corner. */
  function areaRect() {
    const pane = frame?.closest?.('.reading-pane');
    const column = pane || frame?.closest?.('.message-view');
    const v = pane ? pane.getBoundingClientRect() : null;
    const h = column ? column.getBoundingClientRect() : null;
    return {
      top: v ? Math.max(v.top, 0) : 0,
      bottom: v ? Math.min(v.bottom, window.innerHeight) : window.innerHeight,
      left: h ? Math.max(h.left, 0) : 0,
      right: h ? Math.min(h.right, window.innerWidth) : window.innerWidth,
    };
  }

  function reposition() {
    if (!bar) return;
    const r = areaRect();
    // Custom properties, not top/right directly: the mobile media query in
    // app.css overrides the horizontal placement to span the pane, and an
    // inline style would beat it.
    bar.style.setProperty('--find-top', Math.max(8, r.top + 10) + 'px');
    bar.style.setProperty('--find-right', Math.max(8, window.innerWidth - r.right + 12) + 'px');
  }

  function send(data) {
    if (!frame || !frame.isConnected) {
      // The frame is rebuilt from scratch on a theme change (app.js#
      // refreshOpenMessageTheme) — re-attach rather than going dead. The new
      // frame knows nothing of the search, so whatever was being asked
      // (usually "next hit") becomes a fresh search for the same text.
      frame = currentFrame();
      if (!frame) { close(); return; }
      MessageFrame.sendFind(frame, { type: 'hmelj-find', token: ++token, query: bar.querySelector('.find-input').value });
      return;
    }
    MessageFrame.sendFind(frame, data);
  }

  function runSearch() {
    const q = bar.querySelector('.find-input').value;
    send({ type: 'hmelj-find', token: ++token, query: q });
  }

  function step(dir) {
    if (!count) return;
    send({ type: 'hmelj-find-step', token: ++token, dir });
  }

  /** Brings the reported hit into view, never behind the bar.
   *  `top`/`height` are in the frame's own coordinates, which — because the
   *  frame never scrolls — are just an offset from the iframe element itself. */
  function scrollToHit(top, height) {
    const scroller = MessageFrame.scrollerFor(frame);
    if (!scroller) return;
    const area = areaRect();
    const barBox = bar.getBoundingClientRect();
    const safeTop = Math.max(area.top, barBox.bottom) + 12;
    const safeBottom = area.bottom - 16;
    const hitTop = frame.getBoundingClientRect().top + top;
    if (hitTop >= safeTop && hitTop + height <= safeBottom) return; // comfortably visible already
    // Parked a quarter of the way down the usable band rather than flush
    // under the bar: a hit pinned to the very top reads as if it were cut off,
    // and the line above it is usually the sentence it belongs to.
    const target = safeTop + Math.max(0, (safeBottom - safeTop) * 0.25);
    scroller.scrollTop += hitTop - target;
  }

  function paintCount() {
    const el = bar.querySelector('.find-count');
    const q = bar.querySelector('.find-input').value;
    el.textContent = !q ? '' : count ? `${index + 1}/${count}` : t('No results');
    el.classList.toggle('find-count-none', !!q && !count);
    for (const b of bar.querySelectorAll('.find-nav')) b.disabled = !count;
  }

  function onFrameMessage(f, data) {
    if (data.type === 'hmelj-find-open') { open(f); return; }
    if (data.type === 'hmelj-find-close') { close(); return; }
    if (data.type !== 'hmelj-find-result' || !bar || f !== frame) return;
    if (data.token !== token) return; // superseded by a newer keystroke/step
    count = data.count || 0;
    index = typeof data.index === 'number' ? data.index : -1;
    paintCount();
    if (typeof data.top === 'number') scrollToHit(data.top, data.height || 0);
  }

  function onKeydown(e) {
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    if (e.key === 'Enter') {
      e.preventDefault();
      // Enter re-runs nothing — the search is already live as you type, so it
      // only ever means "next" (Shift+Enter: previous), like every other find
      // bar the user has met.
      step(e.shiftKey ? -1 : 1);
    }
  }

  function build() {
    const el = document.createElement('div');
    el.className = 'find-bar';
    el.setAttribute('role', 'search');
    el.innerHTML = `
      <input type="text" class="find-input" autocomplete="off" spellcheck="false"
             placeholder="${t('Search in message')}" aria-label="${t('Search in message')}">
      <span class="find-count" aria-live="polite"></span>
      <button type="button" class="find-nav" data-dir="-1" title="${t('Previous')}" aria-label="${t('Previous')}">↑</button>
      <button type="button" class="find-nav" data-dir="1" title="${t('Next')}" aria-label="${t('Next')}">↓</button>
      <button type="button" class="find-close" title="${t('Close')}" aria-label="${t('Close')}">✕</button>`;
    el.addEventListener('keydown', onKeydown);
    el.querySelector('.find-input').addEventListener('input', () => {
      // Debounced: every keystroke re-walks the whole body, and a long
      // newsletter is a lot of text nodes to visit per character.
      clearTimeout(debounce);
      debounce = setTimeout(runSearch, 120);
      if (!bar.querySelector('.find-input').value) { count = 0; index = -1; paintCount(); }
    });
    for (const b of el.querySelectorAll('.find-nav')) {
      b.addEventListener('click', () => {
        step(+b.dataset.dir);
        el.querySelector('.find-input').focus(); // keep Enter/Escape working after a click
      });
    }
    el.querySelector('.find-close').addEventListener('click', close);
    return el;
  }

  /** Opens the bar over `f` (defaults to whatever message is on screen).
   *  Already open: just re-focus and select, so a second Ctrl+F is "search
   *  for something else" rather than a no-op. */
  function open(f) {
    const target = f || currentFrame();
    if (!target) return;
    if (bar && frame === target) {
      const input = bar.querySelector('.find-input');
      input.focus(); input.select();
      return;
    }
    if (bar) close();
    frame = target;
    bar = build();
    document.body.appendChild(bar);
    reposition();
    window.addEventListener('resize', reposition);
    // The pane changes size without the window doing so — the layout picker
    // (right/bottom/off), the list column being dragged, the mobile keyboard.
    const pane = frame.closest('.reading-pane');
    if (window.ResizeObserver && pane) {
      ro = new ResizeObserver(reposition);
      ro.observe(pane);
    }
    paintCount();
    bar.querySelector('.find-input').focus();
  }

  function close() {
    if (!bar) return;
    clearTimeout(debounce);
    if (frame && frame.isConnected) MessageFrame.sendFind(frame, { type: 'hmelj-find-clear' });
    window.removeEventListener('resize', reposition);
    ro?.disconnect();
    ro = null;
    bar.remove();
    bar = null;
    frame = null;
    count = 0; index = -1;
  }

  /** True when a keystroke belongs to something the user is typing in
   *  (compose, the mailbox search box, a dialog field) — Ctrl+F there is the
   *  browser's own find, and hijacking it would be taking a key away from the
   *  thing the user is actually looking at. */
  function typingElsewhere() {
    const a = document.activeElement;
    if (!a || (bar && bar.contains(a))) return false;
    if (a.isContentEditable) return true;
    const tag = a.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
  }

  function composeOpen() {
    const c = document.getElementById('compose-window');
    return !!c && !c.hidden;
  }

  window.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    if (e.key !== 'f' && e.key !== 'F') return;
    if (typingElsewhere() || composeOpen()) return;
    if (!currentFrame()) return; // no message on screen — leave the browser's own find alone
    e.preventDefault();
    open();
  });

  if (window.MessageFrame) MessageFrame.onFindMessage(onFrameMessage);

  return { open, close, isOpen };
})();
if (typeof window !== 'undefined') window.MessageFind = MessageFind;
