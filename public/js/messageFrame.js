// Hmelj — sandboxed rendering for message bodies.
// Email HTML/CSS is isolated in a sandboxed iframe so a message's own <style>
// block can never leak out and restyle the rest of the app.
const MessageFrame = (() => {
  function esc(s) { const d = document.createElement('div'); d.textContent = s ?? ''; return d.innerHTML; }
  // <style> is a "raw text" element — entity-encoding alone won't stop a value
  // containing a literal "</style" from closing the tag early, so strip angle
  // brackets from anything we splice into CSS (values here come from a fixed
  // font-family <select>, but this is cheap defense-in-depth regardless).
  function cssSafe(s) { return String(s ?? '').replace(/[<>]/g, ''); }
  // An attribute value needs one escape esc() doesn't do: textContent/innerHTML
  // leaves a literal " alone (harmless in text, but it closes an href early).
  function attrEsc(s) { return esc(s).replace(/"/g, '&quot;'); }

  /* A text/plain body has no markup, so a URL in it is just characters — which
     is why "kliknite na povezavo: https://…" rendered as inert text you had to
     copy by hand. Real mail is full of them (forum notifications, mailing
     lists, password resets), so bare URLs are turned into real anchors here.
     They then take exactly the same route HTML mail's links already take: the
     frame's click handler cancels the navigation and postMessage()s the href
     out to the parent, which opens it in the external browser. */
  const LINK_RE = new RegExp([
    'https?://[^\\s<>"\'`]+',            // explicit scheme
    'www\\.[^\\s<>"\'`]+',               // scheme-less, still unambiguously a host
    'mailto:[^\\s<>"\'`]+',
    "[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\\.[A-Za-z0-9-]+)+", // bare address
  ].join('|'), 'g');

  /* Senders write "…povezavo: https://host/x." and "(see https://host/x)" —
     the sentence's own punctuation is not part of the URL. Trailing marks are
     trimmed back off the match, except a closing bracket that something inside
     the URL actually opened (Wikipedia's …/Foo_(disambiguation) being the
     classic). A trailing / or = is left alone: those really can end a URL. */
  const CLOSERS = { ')': '(', ']': '[', '}': '{' };
  function trimTrailingPunctuation(u) {
    let end = u.length;
    while (end > 0) {
      const c = u[end - 1];
      if ('.,;:!?«»“”„‘’\'"'.includes(c)) { end--; continue; }
      const open = CLOSERS[c];
      if (open) {
        const inner = u.slice(0, end);
        const opened = inner.split(open).length - 1;
        const closed = inner.split(c).length - 1;
        if (closed > opened) { end--; continue; }
      }
      break;
    }
    return u.slice(0, end);
  }

  /** Escape `text` as HTML, turning bare URLs/addresses into anchors. */
  function linkifyText(text) {
    const src = String(text ?? '');
    let out = '';
    let last = 0;
    LINK_RE.lastIndex = 0;
    for (let m; (m = LINK_RE.exec(src));) {
      const url = trimTrailingPunctuation(m[0]);
      // All that survived the trim was punctuation — nothing to link.
      if (!url) { LINK_RE.lastIndex = m.index + m[0].length; continue; }
      let href = url;
      if (/^www\./i.test(url)) href = 'https://' + url;
      else if (!/^(?:https?|mailto):/i.test(url)) href = 'mailto:' + url;
      out += esc(src.slice(last, m.index));
      out += `<a href="${attrEsc(href)}" target="_blank" rel="noopener noreferrer">${esc(url)}</a>`;
      last = m.index + url.length;
      LINK_RE.lastIndex = last;
    }
    return out + esc(src.slice(last));
  }
  // A generic keyword (serif, sans-serif, …) must NOT be quoted in CSS — a
  // quoted 'serif' is parsed as a literal (nonexistent) font family NAMED
  // "serif", not the keyword, and would silently fail to apply at all. An
  // actual font name (a custom uploaded family, possibly containing spaces)
  // needs quoting instead — this list mirrors app.js's own GENERIC_FONTS ids
  // (duplicated, not imported: this file has no dependency on app.js at all,
  // and is loaded standalone by message.html's popout too).
  const GENERIC_FONT_IDS = new Set(['system-ui', 'serif', 'sans-serif', 'monospace', 'cursive']);
  function fontFamilyCss(font) {
    const f = cssSafe(font);
    return GENERIC_FONT_IDS.has(f) ? f : `'${f}'`;
  }

  const FONT_STYLE_CSS = { regular: ['normal', 400], bold: ['normal', 700], italic: ['italic', 400], boldItalic: ['italic', 700] };
  /** @font-face rules for every admin-uploaded custom font (see GET /api/fonts
   * in app.js / server/fonts.js) — `fonts`: [{family, styles: {regular, bold,
   * italic, boldItalic}}], each style either a URL or null/absent. Shared by
   * both consumers of this file: app.js injects this into the main
   * document's own <head> (for the App font picker), and buildDoc() below
   * inlines it into the sandboxed message iframe's own <style> (for the
   * Message font picker) — a custom family has to be registered separately
   * in each document, @font-face doesn't cross a srcdoc iframe boundary. */
  function buildFontFaceCss(fontsList) {
    return (fontsList || []).map((f) => Object.entries(f.styles || {})
      .filter(([, url]) => url)
      .map(([style, url]) => {
        const [fontStyle, weight] = FONT_STYLE_CSS[style] || ['normal', 400];
        return `@font-face{font-family:'${cssSafe(f.family)}';src:url('${cssSafe(url)}');font-style:${fontStyle};font-weight:${weight};font-display:swap;}`;
      }).join('')).join('');
  }

  // `dark` (boolean) is a legacy fallback for callers that don't have
  // access to the app's live theme variables (the message.html popout
  // window) — bg/fg/link/dim (actual computed colors of the *current*
  // theme, whichever of the 6 it is) take priority when given, so a message
  // reads in Sepia/Contrast/Midnight tones instead of always plain white,
  // which a light/dark binary alone can't express.
  /* Where a plain-text body stops being this message and starts being the one
     it replies to. Everything from that line down is the quote.

     Matched conservatively — a false positive hides text the sender actually
     wrote, which is far worse than leaving a quote on screen. So: a real
     quote marker only, at the start of a line. Slovenian and English
     attribution lines are both here (this app's two languages); anything else
     still falls back to the '>' convention, which every mail client on earth
     produces. */
  const QUOTE_LINE_RE = new RegExp([
    '^>',                                                   // the universal quote convention
    '^-{2,}\\s*(Original Message|Forwarded message|Izvirno sporo[čc]ilo|Posredovano sporo[čc]ilo)',
    '^_{10,}$',                                             // Outlook's rule between reply and quote
    '^(On|Dne|V|Am|Le) .{0,160}(wrote|napisal|napisala|zapisal|zapisala|schrieb)[^:]{0,6}:\\s*$',
    '^From:\\s.+$',                                          // Outlook's header block, always followed by Sent:/To:
    '^Od:\\s.+$',
  ].join('|'), 'i');

  /** Splits a plain-text body into what was written now and what is quoted.
   *  Returns null when there is no quote worth collapsing — nothing to hide,
   *  nothing above it to show, or a quote so short the toggle would be noise. */
  function splitQuotedText(text) {
    const lines = String(text ?? '').split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (!QUOTE_LINE_RE.test(lines[i])) continue;
      const above = lines.slice(0, i).join('\n');
      const below = lines.slice(i).join('\n');
      // Something to read above it, and enough below it to be worth a click.
      if (above.trim().length < 20 || below.trim().length < 120) return null;
      return { above, below };
    }
    return null;
  }

  /** The '…' button plus the collapsed block, in the markup shape the frame
   *  script's one toggle handler understands (see the quote block there). */
  function quoteToggleHtml(innerHtml) {
    return `<button type="button" class="hmelj-quote-toggle" title="Show trimmed content">&#8943;</button>`
      + `<div class="hmelj-quoted">${innerHtml}</div>`;
  }

  function buildDoc({ html, text, fontFamily, fontSize, dark, bg, fg, link, dim, fonts }) {
    let body;
    if (html) {
      body = html;
    } else {
      // Plain text is split HERE rather than in the frame: the raw text is
      // right in front of us, line-based splitting on it is exact, and doing
      // it after linkifyText() would mean cutting HTML on line boundaries
      // through anchors it had just built.
      const parts = splitQuotedText(text);
      body = parts
        ? `<pre>${linkifyText(parts.above)}</pre>${quoteToggleHtml(`<pre>${linkifyText(parts.below)}</pre>`)}`
        : `<pre>${linkifyText(text)}</pre>`;
    }
    fg = cssSafe(fg) || (dark ? '#e3e6ea' : '#1f1f1f');
    bg = cssSafe(bg) || (dark ? '#1b1f24' : '#ffffff');
    link = cssSafe(link) || (dark ? '#8ab4f8' : '#0b57d0');
    dim = cssSafe(dim) || (dark ? '#9aa0a6' : '#888888');
    return `<!doctype html><html><head><meta charset="utf-8">
<style>
${buildFontFaceCss(fonts)}
/* !important: some HTML email templates set a fixed height + overflow:auto
   on their own <body> (later in source order than this block, so it would
   otherwise win the cascade) — that turns into a second, inner scrollbar on
   top of Hmelj's own outer one for the message. Forcing height:auto here
   means the frame always reports its *true* full content height below, and
   the reading pane (see app.css) is the only thing that scrolls vertically. */
html,body{margin:0!important;padding:0!important;height:auto!important;max-height:none!important;overflow-y:hidden!important;}
/* A too-wide message (a fixed-width table from an email template, say —
   plain max-width:100% can't force an element below its own intrinsic
   minimum content width) scrolls horizontally instead of being forced to
   fit. An earlier version of this tried to auto-shrink wide content to fit
   via a JS-computed scale transform instead — abandoned after it proved
   unable to reliably measure "true content width" for some real-world
   templates (AliExpress's promotional emails in particular: deeply nested
   MJML tables, some genuinely responsive, some not, defeated every
   measurement approach tried). Native scroll has none of that fragility —
   the browser always knows exactly how wide its own content is — and
   matches how actual mobile mail clients (AquaMail, confirmed) handle the
   same messages: fit what you can, drag/scroll sideways for the rest.
   Touch-dragging to scroll is free once overflow-x is scrollable (native
   browser behavior); a plain mouse has no equivalent native gesture, so
   desktop gets Ctrl-drag-to-pan instead (see the pan block in the script
   below). */
html,body{overflow-x:auto!important;}
/* Ctrl-drag to pan (see the pan block in the script below). The cursor has to
   beat every element's own (links, images and table cells all set their own),
   hence the universal selector + !important. user-select is suppressed only
   once a drag is actually under way — applying it on Ctrl-HOLD would fight
   Ctrl+C, which is the far more common reason to be holding Ctrl over a
   message. */
html.hmelj-pan-ready,html.hmelj-pan-ready *{cursor:grab!important;}
html.hmelj-panning,html.hmelj-panning *{cursor:grabbing!important;user-select:none!important;-webkit-user-select:none!important;}
html{scrollbar-color:${dim} transparent;scrollbar-width:thin;}
::-webkit-scrollbar{width:9px;height:9px;}
::-webkit-scrollbar-track{background:transparent;}
::-webkit-scrollbar-thumb{background:${dim};border-radius:8px;}
body{font-family:${fontFamilyCss(fontFamily)},system-ui,sans-serif;font-size:${cssSafe(fontSize)}px;color:${fg};background:${bg};word-wrap:break-word;overflow-wrap:break-word;}
pre{white-space:pre-wrap;font-family:inherit;}
/* pre-wrap breaks at whitespace only, so one long linkified URL (query
   strings in forum/reset mails run well past 80 chars) would push a
   plain-text body into the horizontal scroll meant for wide HTML layouts.
   Only the anchor is allowed to break mid-string — the surrounding text
   keeps the line breaks the sender chose. */
pre a{overflow-wrap:anywhere;}
/* !important: some email templates set explicit fixed width/height (as
   attributes or, worse, an inline style="") directly on <img> to dodge
   client-specific resizing quirks — an inline style attribute normally
   outranks a plain rule in this stylesheet, which let a fixed-height image
   shrink in width (via the max-width rule further down) but stay at its
   original fixed height, visibly squashing/stretching it. !important here
   forces the resize to keep the image's own aspect ratio regardless.
   :not(.blocked-image) — a blocked placeholder (server/index.js's
   sanitizeMessageHtml) has no actual image content to protect the aspect
   ratio OF; it deliberately carries over the ORIGINAL width/height/style so
   the placeholder occupies the same footprint the real image would have
   (some templates size table cells/columns by their image's own dimensions
   — forcing height:auto here would undo exactly the sizing this is meant
   to preserve, collapsing/reflowing that layout instead of leaving an
   appropriately-sized placeholder box). */
img{max-width:100%!important;}
img:not(.blocked-image){height:auto!important;}
table{max-width:100%!important;}
a{color:${link};}
img.blocked-image{border:1px dashed ${dim};padding:8px;color:${dim};box-sizing:border-box;}
/* Collapsed quote — the "previously, in this thread" half of a reply, hidden
   behind the ⋯ button until asked for (see the quote block in the script
   below, and splitQuotedText() for the plain-text half of the same feature).
   !important because a quoted block in HTML mail routinely carries its own
   inline display/visibility. */
.hmelj-quoted{display:none!important;}
.hmelj-quote-toggle{
  display:inline-block;margin:6px 0;padding:1px 10px;border:0;border-radius:10px;
  background:rgba(128,128,128,.28);color:${fg};cursor:pointer;
  font:inherit;font-size:15px;line-height:1.5;letter-spacing:1px;
}
.hmelj-quote-toggle:hover{background:rgba(128,128,128,.45);}
/* In-message search (Ctrl+F — see the find block in the script below, driven
   from messageFind.js in the parent). The CSS Custom Highlight API paints
   ranges without touching the DOM at all: no <mark> wrappers spliced into a
   stranger's HTML, so a message's own layout, links and table widths are
   bit-for-bit what they were before the search, nothing reflows (which would
   fight the height reporting below), and clearing a search is one call rather
   than an unwrap pass that has to put every split text node back. */
::highlight(hmelj-find){background:#ffe066;color:#1f1f1f;}
::highlight(hmelj-find-current){background:#ff8f1f;color:#1f1f1f;}
</style>
</head><body>${body}</body>
<script>
(function(){
  // Force every element's own background to the theme color EXCEPT where
  // that would break its own text: some HTML emails deliberately pair a
  // background with a text color (white on a gray banner, say), and
  // stripping just the background orphans that text against whatever's now
  // showing through instead — potentially unreadable (white on white).
  // Per-element, not blanket: read what's actually rendered (computed
  // style already resolves inheritance + any <style> block, not just
  // inline attributes), and only override where the element's own text
  // would still pass a normal contrast check against the theme background.
  // Anywhere that fails, leave that one element's original background
  // alone — a small, contained exception instead of a global one.
  function parseColor(str) {
    str = (str || '').trim();
    var m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(str);
    if (m) {
      var hex = m[1];
      if (hex.length === 3) hex = hex.replace(/(.)/g, '$1$1');
      return { r: parseInt(hex.slice(0, 2), 16), g: parseInt(hex.slice(2, 4), 16), b: parseInt(hex.slice(4, 6), 16), a: 1 };
    }
    m = /rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+))?\)/.exec(str);
    if (m) return { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] };
    return null;
  }
  function relLuminance(c) {
    var ch = [c.r, c.g, c.b].map(function (v) {
      v = v / 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
  }
  function contrastRatio(c1, c2) {
    var l1 = relLuminance(c1), l2 = relLuminance(c2);
    var lighter = Math.max(l1, l2), darker = Math.min(l1, l2);
    return (lighter + 0.05) / (darker + 0.05);
  }
  function applyThemeBackgrounds() {
    var themeBg = parseColor(${JSON.stringify(bg)});
    if (!themeBg) return;
    var els = document.body.querySelectorAll('*');
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      var cs = getComputedStyle(el);
      var ownBg = parseColor(cs.backgroundColor);
      if (!ownBg || ownBg.a === 0) continue; // nothing of its own to override
      var textColor = parseColor(cs.color);
      if (textColor && contrastRatio(textColor, themeBg) < 4.5) continue; // would go unreadable — leave this one alone
      el.style.setProperty('background-color', 'transparent', 'important');
    }
  }
  document.addEventListener('click', function (e) {
    var a = e.target.closest && e.target.closest('a[href]');
    if (!a) return;
    e.preventDefault();
    try { parent.postMessage({ type: 'hmelj-link', href: a.href }, '*'); } catch (err) {}
  });
  applyThemeBackgrounds();
})();
(function(){
  // Pinch/double-tap-to-zoom IN for detail (unrelated to fit now — there's
  // no "fit" baseline anymore, see the overflow-x:auto CSS above; wide
  // content scrolls horizontally instead, and Ctrl-drag-to-pan below covers
  // desktop mouse the way touch already gets it natively). Deliberately NOT
  // the browser's native page-zoom (the host app disables that globally;
  // see index.html/message.html's viewport meta) so a pinch gesture over a
  // message's content never also zooms Hmelj's own UI.
  var target = document.body;
  target.style.transformOrigin = '0 0';
  var scale = 1, tx = 0, ty = 0;
  var MAX_SCALE = 4;
  var pinchStartDist = 0, pinchStartScale = 1;
  var anchorX = 0, anchorY = 0; // content-space point (unscaled body coords) that should stay under the fingers for the current pinch
  var panStart = null;
  var lastTapAt = 0;

  // Two things were making pinch/pan feel jerky rather than smooth, both
  // classic CSS-transform-animation pitfalls:
  //  1. No will-change hint — the browser doesn't promote <body> to its own
  //     GPU compositing layer ahead of time, so (especially for a long
  //     email, lots of images) the first transform of a gesture can force
  //     an expensive rasterize instead of a cheap GPU-only re-composite.
  //     Only held for the DURATION of an actual gesture (set on
  //     touchstart, cleared once back at rest in resetZoom) rather than
  //     permanently, since keeping a layer promoted costs memory for no
  //     benefit while nothing's being zoomed.
  //  2. touchmove firing (and writing style.transform) more often than the
  //     display can actually paint — every extra write past what one frame
  //     can show is pure wasted, blocking work. Batched through
  //     requestAnimationFrame instead: touchmove just records the latest
  //     numbers, and at most one style write actually happens per frame.
  var rafScheduled = false;
  function setTransform() {
    target.style.transform = (scale === 1 && tx === 0 && ty === 0) ? '' : 'translate(' + tx + 'px,' + ty + 'px) scale(' + scale + ')';
  }
  function scheduleTransform() {
    if (rafScheduled) return;
    rafScheduled = true;
    requestAnimationFrame(function () { rafScheduled = false; setTransform(); });
  }
  function dist(a, b) { var dx = a.clientX - b.clientX, dy = a.clientY - b.clientY; return Math.sqrt(dx * dx + dy * dy); }
  function mid(a, b) { return { x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 }; }
  function resetZoom() { scale = 1; tx = 0; ty = 0; target.style.willChange = ''; setTransform(); }
  // Inverse of the translate(tx,ty) scale(s) transform above (transform-
  // origin is fixed at (0,0), so this is just "undo scale then translate"):
  // the content-space point currently sitting under screen point m.
  function screenToContent(m) { return { x: (m.x - tx) / scale, y: (m.y - ty) / scale }; }

  document.addEventListener('touchstart', function (e) {
    if (e.touches.length === 2) {
      target.style.willChange = 'transform';
      pinchStartDist = dist(e.touches[0], e.touches[1]);
      pinchStartScale = scale;
      var a = screenToContent(mid(e.touches[0], e.touches[1]));
      anchorX = a.x; anchorY = a.y;
      panStart = null;
      attachMove();
    } else if (e.touches.length === 1) {
      if (scale > 1) {
        target.style.willChange = 'transform';
        panStart = { x: e.touches[0].clientX, y: e.touches[0].clientY, tx0: tx, ty0: ty };
        attachMove();
      } else {
        var now = Date.now();
        if (now - lastTapAt < 300) resetZoom(); // double-tap resets (a no-op if already at rest)
        lastTapAt = now;
      }
    }
  }, { passive: true });

  function onTouchMove(e) {
    if (e.touches.length === 2 && pinchStartDist) {
      e.preventDefault();
      var d = dist(e.touches[0], e.touches[1]);
      scale = Math.min(MAX_SCALE, Math.max(1, pinchStartScale * (d / pinchStartDist)));
      // Solve tx/ty so the SAME content point (anchorX, anchorY) — wherever
      // in the message it was when this pinch started — stays under the
      // fingers' current midpoint at the new scale. Without this, scaling
      // only ever grows outward from <body>'s fixed transform-origin
      // (0,0) — the top-left corner — regardless of where you actually
      // pinched, which was the reported bug.
      var m = mid(e.touches[0], e.touches[1]);
      tx = m.x - anchorX * scale;
      ty = m.y - anchorY * scale;
      scheduleTransform();
    } else if (e.touches.length === 1 && panStart) {
      e.preventDefault();
      tx = panStart.tx0 + (e.touches[0].clientX - panStart.x);
      ty = panStart.ty0 + (e.touches[0].clientY - panStart.y);
      scheduleTransform();
    }
  }
  // Registered only WHILE an actual pinch/pan gesture is in progress
  // (attached above in touchstart, detached below in touchend) — NEVER
  // sitting on document at rest, so it can never interfere with the native
  // horizontal scroll a plain one-finger drag now uses (overflow-x:auto —
  // see the <style> above) at the normal, unzoomed scale. A non-passive
  // touchmove listener present at rest would force the browser to run this
  // handler (a main-thread round trip) before it can even START that native
  // scroll, on every touchmove.
  var moveAttached = false;
  function attachMove() {
    if (moveAttached) return;
    moveAttached = true;
    document.addEventListener('touchmove', onTouchMove, { passive: false });
  }
  function detachMove() {
    if (!moveAttached) return;
    moveAttached = false;
    document.removeEventListener('touchmove', onTouchMove, { passive: false });
  }

  document.addEventListener('touchend', function (e) {
    if (e.touches.length < 2) pinchStartDist = 0;
    if (e.touches.length === 0) { panStart = null; detachMove(); if (scale <= 1) resetZoom(); }
  }, { passive: true });

  // A plain mouse drag used to pan a too-wide message sideways. It doesn't
  // any more — it selects text, like a drag anywhere else on the web. The
  // gesture can't be both: the browser starts a selection on mousedown, so
  // panning meant either living with text being selected underneath the drag
  // or killing selection inside message bodies outright, and it had to skip
  // links entirely (a drag starting on one would otherwise follow it). Ctrl
  // holding the pan below is what made the plain drag free to go back to
  // being an ordinary drag; touch is unaffected either way (it pans natively,
  // from overflow-x:auto).

  // Ctrl-drag to pan — the drag a plain one can't be. It works anywhere in
  // the message (over a link too: Ctrl pressed there means "pan", not
  // "follow"), it never starts a text selection, and the cursor turns into a
  // hand the moment Ctrl goes down, so it announces itself instead of being
  // something you have to already know about.
  //
  // Offered whenever the message is too WIDE — that's the case a mouse has no
  // other good answer for — but once a drag is under way it moves both axes:
  // sideways in here, and vertically by asking the parent to scroll (this
  // frame has no vertical scroll of its own at all; its height always equals
  // its content and the reading pane outside is what scrolls).
  //
  // Whether Ctrl is down has to come from three places, because no single one
  // of them is enough: the parent document forwards it (this frame almost
  // never has keyboard focus, so its own key events usually never fire at
  // all), the frame's own key events cover the case where it does, and every
  // mouse event carries ctrlKey, which corrects the other two whenever a
  // keyup goes missing — alt-tab, or any browser shortcut that steals focus
  // mid-press.
  var ctrlHeld = false;
  var pan = null;
  var suppressClick = false;

  /** The element that actually scrolls sideways, or null when the message
   *  already fits — panning is only offered when there is something to pan,
   *  which is also what tells the user (no hand cursor) that it won't help. */
  function panTarget() {
    var b = document.body, d = document.documentElement;
    if (b.scrollWidth > b.clientWidth) return b;
    if (d.scrollWidth > d.clientWidth) return d;
    return null;
  }
  function updatePanCursor() {
    document.documentElement.classList.toggle('hmelj-pan-ready', ctrlHeld && !pan && !!panTarget());
  }
  function setCtrl(down) {
    if (down === ctrlHeld) return;
    ctrlHeld = down;
    updatePanCursor();
  }
  window.addEventListener('message', function (e) {
    if (e.source !== parent || !e.data || e.data.type !== 'hmelj-ctrl') return;
    setCtrl(!!e.data.down);
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Control') setCtrl(true); });
  document.addEventListener('keyup', function (e) { if (e.key === 'Control') setCtrl(false); });
  window.addEventListener('blur', function () { setCtrl(false); });
  document.addEventListener('mousemove', function (e) { setCtrl(e.ctrlKey); }, true);

  document.addEventListener('mousedown', function (e) {
    if (e.button !== 0 || !e.ctrlKey) return;
    var el = panTarget();
    if (!el) return;
    // Stops the text selection (and the link/image drag) that would otherwise
    // start under the cursor — the entire point of holding Ctrl. The click
    // event still fires afterwards, which is why an actual drag suppresses it
    // below; a Ctrl-CLICK that never moved still opens its link, exactly as
    // it did before this existed.
    e.preventDefault();
    pan = { el: el, x: e.clientX, y: e.screenY, lastY: e.screenY, left: el.scrollLeft, moved: false };
    document.documentElement.classList.add('hmelj-panning');
    updatePanCursor();
  }, true);
  document.addEventListener('mousemove', function (e) {
    if (!pan) return;
    e.preventDefault();
    // Two different origins, because the two axes move different things.
    // Sideways scrolls THIS frame's own body, which never moves the frame
    // itself, so clientX stays an exact CSS-pixel measure of how far the
    // mouse went. Vertically the PARENT scrolls, which slides this whole
    // iframe up the page under a stationary cursor — clientY would climb by
    // exactly what we just scrolled and the pan would run away on its own.
    // screenY is measured against the screen, which nothing here moves.
    // (Its one cost: at a browser zoom other than 100% screen pixels aren't
    // CSS pixels, so vertical panning runs proportionally fast/slow there.)
    var dx = e.clientX - pan.x;
    if (Math.abs(dx) > 3 || Math.abs(e.screenY - pan.y) > 3) pan.moved = true; // a few px of hand tremor is still a click, not a drag
    pan.el.scrollLeft = pan.left - dx;
    var dy = e.screenY - pan.lastY;
    if (dy) {
      pan.lastY = e.screenY;
      // Incremental, not cumulative: the parent clamps at the ends of its own
      // scroll range, and a total measured from the press would fight that
      // clamp every frame once the message is scrolled all the way down.
      try { parent.postMessage({ type: 'hmelj-pan', dy: dy }, '*'); } catch (err) {}
    }
  }, true);
  // Ends on leaving the frame as well: mouse events stop being delivered in
  // here the moment the cursor crosses out of the iframe, so a drag left
  // running would strand the grabbing cursor until the next click.
  function endPan() {
    if (!pan) return;
    suppressClick = pan.moved;
    pan = null;
    document.documentElement.classList.remove('hmelj-panning');
    updatePanCursor();
    // The click that follows a mouseup is dispatched before a timeout queued
    // during that mouseup — so this clears the flag right after the click it
    // is meant for, and a pan that ended with no click at all (the cursor
    // left the frame) can't swallow some later, unrelated one.
    setTimeout(function () { suppressClick = false; }, 0);
  }
  document.addEventListener('mouseup', endPan, true);
  document.addEventListener('mouseleave', endPan);
  // A pan that happens to finish on a link must not also open it — the link
  // handler further up turns every click into a parent-side window.open.
  // Capture phase on document, so this sees the click before that handler
  // gets it at all.
  document.addEventListener('click', function (e) {
    if (!suppressClick) return;
    suppressClick = false;
    e.preventDefault();
    e.stopPropagation();
  }, true);
  // macOS delivers ctrl+click as a right-click: without this, starting a pan
  // there pops the browser's own context menu open over the message.
  document.addEventListener('contextmenu', function (e) { if (pan) e.preventDefault(); });

  // Height still needs to be measured and reported to the parent — the
  // frame's own height always matches its content exactly, so the outer
  // reading pane (not this frame) is the only thing that scrolls
  // vertically (see app.css). Unlike width, this never needed the fragile
  // measurement approach that caused so much trouble above: scrollHeight
  // has no equivalent "which element, which axis" ambiguity, and nothing
  // here depends on knowing whether content overflows horizontally at all.
  function reportHeight() {
    try {
      parent.postMessage({ type: 'hmelj-resize', height: document.body.scrollHeight * scale }, '*');
    } catch (e) {}
  }
  reportHeight();
  if (window.ResizeObserver) new ResizeObserver(reportHeight).observe(document.body);
  window.addEventListener('load', reportHeight);
  window.addEventListener('resize', reportHeight);
  // Web fonts (this message's own @font-face/Google-Fonts <link>s, if any)
  // swap in asynchronously, after 'load' — can shift text metrics (and so
  // height) enough to matter. document.fonts isn't universally available
  // inside a sandboxed srcdoc frame in every engine, hence the guard.
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(reportHeight).catch(function () {});
})();
(function(){
  // ── Collapsed quote: the toggle ───────────────────────────────────────────
  // The quote itself is found and marked on the SERVER (server/quoteCollapse.js
  // — see its header for why it isn't done here), which sends the quoted
  // elements with class 'hmelj-quoted' and an inline display:none, and a
  // '⋯' button in front of them. All that is left in here is the click.
  //
  // The same handler serves the plain-text half, where the split happens in
  // buildDoc (splitQuotedText) and emits exactly the same two things.
  function showing(el) { return !el.classList.contains('hmelj-quoted'); }

  document.addEventListener('click', function (e) {
    var btn = e.target.closest && e.target.closest('.hmelj-quote-toggle');
    if (!btn) return;
    e.preventDefault();
    var els = document.querySelectorAll('.hmelj-quoted, .hmelj-quote-shown');
    var opening = false;
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      opening = !showing(el);
      if (opening) {
        el.classList.remove('hmelj-quoted');
        el.classList.add('hmelj-quote-shown');
        // The server hid it with an inline style (nothing in a message's own
        // stylesheet can outrank that); undoing it has to remove the same one.
        try { el.style.removeProperty('display'); } catch (err) {}
      } else {
        el.classList.remove('hmelj-quote-shown');
        el.classList.add('hmelj-quoted');
        try { el.style.setProperty('display', 'none', 'important'); } catch (err) {}
      }
    }
    btn.title = opening ? 'Hide trimmed content' : 'Show trimmed content';
  }, true);
})();
(function(){
  // ── Find in message ───────────────────────────────────────────────────────
  // The search itself HAS to run in here: the frame is sandboxed without
  // allow-same-origin (see create()), so the parent cannot read one character
  // of this document — by design, since allowing it would also hand a
  // message's own scripts a same-origin handle on the app. So the parent owns
  // the UI (messageFind.js) and this owns the text; they talk in postMessage.
  //
  // The parent also owns the SCROLLING, because this frame is always exactly
  // as tall as its content (see reportHeight above) and therefore never
  // scrolls vertically — the reading pane does. So a hit reports where it
  // landed and the parent moves the pane, which is also what lets the parent
  // guarantee the floating search bar never ends up covering the hit.
  var MAX_HITS = 2000; // a one-letter query on a newsletter shouldn't build 50k ranges
  var HL_OK = !!(window.CSS && CSS.highlights && window.Highlight && document.createRange);
  var hits = [], cur = -1, lastQuery = '';

  function clearHighlights() {
    if (!HL_OK) return;
    try { CSS.highlights.delete('hmelj-find'); CSS.highlights.delete('hmelj-find-current'); } catch (e) {}
  }

  /** Visible text of the body as one string, plus the map back to text nodes.
   *  One flat buffer rather than per-node searching, so a hit that straddles
   *  markup ("<b>fold</b>er") is still found — which is most of them in HTML
   *  mail, where senders bold or link half a word without meaning to. */
  function buildIndex() {
    var nodes = [], starts = [], text = '';
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: function (n) {
        if (!n.nodeValue) return NodeFilter.FILTER_REJECT;
        var p = n.parentElement;
        if (!p) return NodeFilter.FILTER_REJECT;
        var tag = p.nodeName;
        if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TITLE') return NodeFilter.FILTER_REJECT;
        // display:none text is real in mail — marketing templates hide a
        // "preheader" line at the top of nearly every newsletter. Matching it
        // would report hits nobody can see and scroll to nothing.
        if (p.offsetParent === null && p !== document.body && getComputedStyle(p).position !== 'fixed') return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    for (var n; (n = walker.nextNode());) {
      nodes.push(n); starts.push(text.length); text += n.nodeValue;
    }
    return { nodes: nodes, starts: starts, text: text };
  }

  /** Index of the text node containing absolute offset 'pos'. */
  function nodeAt(idx, pos) {
    var lo = 0, hi = idx.starts.length - 1, best = 0;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (idx.starts[mid] <= pos) { best = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return best;
  }

  function rangeFor(idx, from, to) {
    var a = nodeAt(idx, from), b = nodeAt(idx, to - 1);
    var r = document.createRange();
    r.setStart(idx.nodes[a], from - idx.starts[a]);
    r.setEnd(idx.nodes[b], to - idx.starts[b]);
    return r;
  }

  function search(query) {
    hits = [];
    cur = -1;
    lastQuery = query;
    clearHighlights();
    if (!query) return;
    var idx = buildIndex();
    // toLowerCase is length-preserving for every alphabet this app is used in;
    // a full Unicode case-fold is not (ß → ss), and any length change would
    // desynchronise the offset map below from the real text nodes.
    var hay = idx.text.toLowerCase(), needle = query.toLowerCase();
    if (hay.length !== idx.text.length) return; // paranoia: bail rather than mis-highlight
    for (var at = hay.indexOf(needle); at !== -1 && hits.length < MAX_HITS; at = hay.indexOf(needle, at + needle.length)) {
      try { hits.push(rangeFor(idx, at, at + needle.length)); } catch (e) { /* torn DOM — skip this one */ }
    }
    if (HL_OK && hits.length) {
      try { CSS.highlights.set('hmelj-find', new Highlight(...hits)); } catch (e) {}
    }
  }

  /** Paints the current hit in the second (stronger) highlight colour. */
  function paintCurrent() {
    if (!HL_OK) return;
    try {
      if (cur >= 0 && hits[cur]) CSS.highlights.set('hmelj-find-current', new Highlight(hits[cur]));
      else CSS.highlights.delete('hmelj-find-current');
    } catch (e) {}
  }

  /** The horizontal half of "bring the hit into view". Vertical is the
   *  parent's job (this frame doesn't scroll); sideways is ours, because a
   *  wide template scrolls inside our own body (see the overflow-x CSS). */
  function scrollHorizontally(rect) {
    for (var el = hits[cur].startContainer.parentElement; el; el = el.parentElement) {
      if (el.scrollWidth <= el.clientWidth + 1) continue;
      var box = el.getBoundingClientRect();
      if (rect.left < box.left) el.scrollLeft -= (box.left - rect.left) + 24;
      else if (rect.right > box.right) el.scrollLeft += (rect.right - box.right) + 24;
      break;
    }
  }

  function report(token) {
    var payload = { type: 'hmelj-find-result', token: token, count: hits.length, index: cur };
    if (cur >= 0 && hits[cur]) {
      var rect = hits[cur].getBoundingClientRect();
      scrollHorizontally(rect);
      rect = hits[cur].getBoundingClientRect(); // re-measure: the sideways scroll just moved it
      // Frame-viewport coordinates ARE frame-content coordinates here (nothing
      // scrolls this document vertically), and getBoundingClientRect already
      // has the pinch-zoom transform baked in, so the parent can use these
      // directly against the iframe element's own position.
      payload.top = rect.top;
      payload.height = rect.height;
    }
    try { parent.postMessage(payload, '*'); } catch (e) {}
  }

  window.addEventListener('message', function (e) {
    if (e.source !== parent || !e.data || typeof e.data !== 'object') return;
    var d = e.data;
    if (d.type === 'hmelj-find') {
      if (d.query !== lastQuery) search(String(d.query || ''));
      cur = hits.length ? 0 : -1;
      paintCurrent();
      report(d.token);
    } else if (d.type === 'hmelj-find-step') {
      if (hits.length) {
        cur = (cur + (d.dir < 0 ? -1 : 1) + hits.length) % hits.length;
        paintCurrent();
      }
      report(d.token);
    } else if (d.type === 'hmelj-find-clear') {
      hits = []; cur = -1; lastQuery = '';
      clearHighlights();
    }
  });

  // Ctrl+F pressed while the caret is inside the message (the user clicked in
  // to select text first) never reaches the parent's own key handler — key
  // events go to the focused document, and that's this one. Hand it out.
  document.addEventListener('keydown', function (e) {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 'f' || e.key === 'F')) {
      e.preventDefault();
      try { parent.postMessage({ type: 'hmelj-find-open' }, '*'); } catch (err) {}
    } else if (e.key === 'Escape') {
      try { parent.postMessage({ type: 'hmelj-find-close' }, '*'); } catch (err) {}
    }
  });
})();
</script>
</html>`;
  }

  /* Ctrl-drag-to-pan needs to know Ctrl is down while the pointer is merely
   * HOVERING a message — but key events go to whatever has keyboard focus,
   * which is this document, not the message frame, until something inside the
   * frame has been clicked. So the state is forwarded in. Posted only on an
   * actual change (not per key repeat), and blur covers the keyup that never
   * arrives because alt-tab took the focus away mid-press. Wired up alongside
   * the frames' own message listener so both consumers of this file — the
   * reading pane and the message.html popout — get it without either having
   * to know about it. */
  /** Whatever actually scrolls a message frame vertically: the reading pane
   *  in the app (.reading-pane, overflow:auto), the window itself in the
   *  message.html popout. Found by walking up rather than by selector, so
   *  neither consumer of this file has to tell the other's layout apart —
   *  and resolved live rather than once at startup, since which ancestor
   *  overflows depends on the message and the window size, not on the markup
   *  alone. */
  let scrollerMemo = null;
  function verticalScrollerFor(frame) {
    // getComputedStyle forces a style resolution, and this runs once per
    // mousemove of a drag — so the answer is remembered for a moment. Short
    // enough that a layout change (the window resized mid-drag) corrects
    // itself, long enough that one drag walks the tree once.
    const now = Date.now();
    if (scrollerMemo && scrollerMemo.frame === frame && now - scrollerMemo.at < 1000) {
      scrollerMemo.at = now;
      return scrollerMemo.el;
    }
    const found = findVerticalScroller(frame);
    scrollerMemo = { frame, el: found, at: now };
    return found;
  }
  function findVerticalScroller(frame) {
    for (let n = frame.parentElement; n; n = n.parentElement) {
      const overflow = getComputedStyle(n).overflowY;
      if ((overflow === 'auto' || overflow === 'scroll' || overflow === 'overlay') && n.scrollHeight > n.clientHeight) return n;
    }
    return document.scrollingElement || document.documentElement;
  }

  let ctrlDown = false;
  function broadcastCtrl(down) {
    if (down === ctrlDown) return;
    ctrlDown = down;
    for (const f of document.querySelectorAll('iframe.mv-body-frame')) {
      try { f.contentWindow?.postMessage({ type: 'hmelj-ctrl', down }, '*'); } catch { /* frame torn down mid-press */ }
    }
  }

  let listening = false;
  function ensureListener() {
    if (listening) return;
    listening = true;
    window.addEventListener('keydown', (e) => { if (e.key === 'Control') broadcastCtrl(true); });
    // Not just the Control keyup: releasing any other key while Ctrl is no
    // longer held (Ctrl+C, then C released last) is the same information, and
    // catches a Control keyup that a browser shortcut swallowed.
    window.addEventListener('keyup', (e) => { if (e.key === 'Control' || !e.ctrlKey) broadcastCtrl(false); });
    window.addEventListener('blur', () => broadcastCtrl(false));
    window.addEventListener('message', (e) => {
      if (!e.data || typeof e.data !== 'object') return;
      const frames = document.querySelectorAll('iframe.mv-body-frame');
      for (const f of frames) {
        if (e.source !== f.contentWindow) continue;
        if (e.data.type === 'hmelj-resize') {
          // The frame always stays exactly as wide as its container — never
          // grows to fit oversized content (that would force the whole
          // reading pane into a page-level horizontal scroll, dragging the
          // header/subject along with it, especially bad on mobile where
          // the reading pane *is* the whole screen). A message wider than
          // that (a fixed-width table from an email template, say) scrolls
          // horizontally *inside* the frame's own body instead — see
          // buildDoc()'s overflow-x:auto + Ctrl-drag-to-pan handling above —
          // only height is ever reported/applied here.
          f.style.height = Math.max(40, +e.data.height || 0) + 'px';
        } else if (e.data.type === 'hmelj-pan') {
          // The vertical half of a Ctrl-drag inside the frame — it can only
          // scroll itself sideways, so the up/down part lands here. Content
          // follows the hand, hence the minus: dragging DOWN reveals what's
          // above, which is a SMALLER scrollTop.
          const el = verticalScrollerFor(f);
          if (el) el.scrollTop -= +e.data.dy || 0;
        } else if (e.data.type === 'hmelj-link') {
          openLink(e.data.href);
        } else if (typeof e.data.type === 'string' && e.data.type.indexOf('hmelj-find') === 0) {
          // In-message search (messageFind.js). Routed through this one
          // listener rather than a second window-level one of its own, so the
          // "which frame said this?" check stays in a single place.
          for (const cb of findListeners) cb(f, e.data);
        }
      }
    });
  }

  /**
   * Opens a link from a message OUTSIDE this app.
   *
   * Lives here rather than in app.js because this file already owns the link
   * protocol and is loaded by the message popout (message.html) too, which has
   * no app.js to borrow from.
   *
   * Inside the native Android shell this has to go through the bridge: that
   * WebView never calls setSupportMultipleWindows(true), so window.open() is
   * silently INERT there — a link in a message body did nothing at all, with no
   * error to see. `openLink` hands it to the system's default browser;
   * `openExternal` (https only, a Custom Tab) is the fallback for an APK built
   * before that method existed.
   *
   * Everywhere else window.open is all there is. A browser cannot choose which
   * application opens a URL — a page in Firefox opens links in Firefox, and no
   * web API can hand one to a different default browser. In a standalone PWA
   * _blank does leave the app's own window, which is the part that was asked
   * for and is achievable.
   */
  function openLink(href) {
    const url = String(href || '');
    if (!/^https?:/i.test(url)) { window.open(url, '_blank', 'noopener'); return; }
    const bridge = window.AndroidApp || window.AndroidCodexa;
    try {
      if (bridge?.openLink) { bridge.openLink(url); return; }
      if (bridge?.openExternal && /^https:/i.test(url)) { bridge.openExternal(url); return; }
    } catch (e) { /* bridge threw — fall through to the ordinary path */ }
    window.open(url, '_blank', 'noopener');
  }

  const findListeners = new Set();
  /** cb(frame, data) for every hmelj-find* message a body frame sends up. */
  function onFindMessage(cb) { findListeners.add(cb); return () => findListeners.delete(cb); }
  /** Post one of the find protocol's messages into `frame`. */
  function sendFind(frame, data) {
    try { frame.contentWindow?.postMessage(data, '*'); } catch { /* frame torn down */ }
  }

  /** Build a sandboxed iframe for a message body and return it (not yet inserted). */
  function create(opts) {
    ensureListener();
    const iframe = document.createElement('iframe');
    iframe.className = 'mv-body-frame';
    iframe.setAttribute('sandbox', 'allow-scripts allow-popups allow-popups-to-escape-sandbox');
    iframe.style.cssText = 'width:100%;border:0;overflow:hidden;display:block;';
    iframe.srcdoc = buildDoc(opts);
    return iframe;
  }

  return { create, buildFontFaceCss, linkifyText, splitQuotedText, onFindMessage, sendFind, openLink, scrollerFor: verticalScrollerFor };
})();
if (typeof window !== 'undefined') window.MessageFrame = MessageFrame;
