// Hmelj — i18n. Each language lives in its own JSON file under /i18n/
// (en.json, sl.json, …) — adding a language is "copy en.json to xx.json and
// translate the values," no JS changes needed for the strings themselves
// (registering the new code in `languages` below and login.html's selector
// is the one place that still needs a one-line edit).
// Static HTML and JS-rendered DOM are translated automatically by a
// MutationObserver walker; only strings that never reach the DOM
// (prompt/confirm) need explicit I18n.t() wrapping.
const I18n = (() => {
  const LANGUAGES = [['en', 'English'], ['sl', 'Slovenščina']];

  let lang = 'en';
  let strings = {};
  let prefixes = [];
  let regexes = []; // [RegExp, replacement][]
  let months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  const cache = {};
  async function loadLanguage(l) {
    if (cache[l]) return cache[l];
    try {
      const res = await fetch(`/i18n/${l}.json`);
      if (!res.ok) throw new Error(res.statusText);
      const data = await res.json();
      cache[l] = {
        strings: data.strings || {},
        prefixes: data.prefixes || [],
        regexes: (data.regexes || []).map(([src, rep]) => [new RegExp(src), rep]),
        months: data.months?.length === 12 ? data.months : months,
      };
    } catch (e) {
      console.warn(`i18n: could not load /i18n/${l}.json`, e);
      cache[l] = { strings: {}, prefixes: [], regexes: [], months };
    }
    return cache[l];
  }

  /* ---------------- engine ---------------- */

  function t(s) {
    if (lang === 'en' || s == null) return s;
    if (strings[s] !== undefined) return strings[s];
    // The remainder gets a translation pass of its own. Most suffixes are
    // variable text (a hostname, a server's own words) and t() hands those back
    // unchanged, exactly as before — but a FIXED message from our own server,
    // e.g. "Could not send: " + "No mail account configured", is a known string
    // and now translates instead of sitting there in English after a Slovenian
    // prefix. Terminates: each step strips a non-empty prefix, so the string
    // strictly shortens.
    for (const [p, r] of prefixes) if (s.startsWith(p)) return r + t(s.slice(p.length));
    for (const [re, rep] of regexes) if (re.test(s)) return s.replace(re, rep);
    // emoji / symbol prefix (e.g. "✏️  Compose"): translate the word part
    const m = s.match(/^([^\p{L}\p{N}]+)(\p{L}.*)$/u);
    if (m && strings[m[2]] !== undefined) return m[1] + strings[m[2]];
    return s;
  }

  // Never translate user content: message bodies, editors, inputs.
  const SKIP_SELECTOR = '.mv-body, .compose-editor, [contenteditable], textarea, pre, [data-no-i18n]';
  const ATTRS = ['title', 'placeholder', 'aria-label'];

  function translateNode(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      const parent = node.parentElement;
      if (!parent || parent.closest(SKIP_SELECTOR)) return;
      const raw = node.nodeValue;
      const trimmed = raw.trim();
      if (!trimmed) return;
      let out;
      // special case: "to X · cc Y" line under the sender
      if (parent.classList.contains('mv-to') && trimmed.startsWith('to ') && lang === 'sl') {
        out = 'za ' + trimmed.slice(3).replace(' · cc ', ' · kp ');
      } else {
        out = t(trimmed);
      }
      if (out !== trimmed) node.nodeValue = raw.replace(trimmed, out);
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    if (node.closest?.(SKIP_SELECTOR)) return;
    for (const a of ATTRS) {
      const v = node.getAttribute?.(a);
      if (v) {
        const tv = t(v);
        if (tv !== v) node.setAttribute(a, tv);
      }
    }
    // walk children, skipping excluded subtrees
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
      acceptNode(n) {
        const el = n.nodeType === Node.ELEMENT_NODE ? n : n.parentElement;
        return el && el.closest(SKIP_SELECTOR) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
      },
    });
    let cur;
    while ((cur = walker.nextNode())) {
      if (cur.nodeType === Node.TEXT_NODE) translateNode(cur);
      else for (const a of ATTRS) {
        const v = cur.getAttribute(a);
        if (v) { const tv = t(v); if (tv !== v) cur.setAttribute(a, tv); }
      }
    }
  }

  let observer = null;
  function startObserver() {
    if (observer) return;
    observer = new MutationObserver((muts) => {
      if (lang === 'en') return;
      for (const m of muts) {
        if (m.type === 'childList') m.addedNodes.forEach(translateNode);
        else if (m.type === 'characterData') translateNode(m.target);
        else if (m.type === 'attributes') translateNode(m.target);
      }
    });
    observer.observe(document.body, {
      childList: true, subtree: true, characterData: true,
      attributes: true, attributeFilter: ATTRS,
    });
  }

  async function init(language) {
    lang = LANGUAGES.some(([code]) => code === language) ? language : 'en';
    document.documentElement.lang = lang;
    const data = await loadLanguage(lang);
    strings = data.strings; prefixes = data.prefixes; regexes = data.regexes; months = data.months;
    if (lang !== 'en') translateNode(document.body);
    pointManifestAt(lang);
    startObserver();
  }

  /**
   * Re-points the <link rel="manifest"> at this language.
   *
   * The manifest is the one visible thing translateNode can never reach: the
   * OS reads it when the app is INSTALLED and builds the window title and the
   * taskbar right-click jump list from it, so a pinned Hmelj showed an English
   * "Compose" no matter what the app's language was. The server answers
   * ?lang=<code> with a translated copy (see server/index.js).
   *
   * Changing the URL is also the signal: an installed PWA re-reads its
   * manifest periodically, and a different href is what makes the new one
   * take. The jump list updates on the OS's own schedule rather than at once,
   * and a reinstall is the way to force it.
   */
  function pointManifestAt(code) {
    try {
      const link = document.querySelector('link[rel="manifest"]');
      if (!link) return;
      const want = `/manifest.webmanifest?lang=${encodeURIComponent(code)}`;
      // Compared against the attribute, not the resolved .href, which the
      // browser expands to an absolute URL and would never match.
      if (link.getAttribute('href') !== want) link.setAttribute('href', want);
    } catch { /* nothing here is worth breaking startup over */ }
  }

  return {
    init,
    t,
    lang: () => lang,
    months: () => months,
    languages: LANGUAGES,
  };
})();
