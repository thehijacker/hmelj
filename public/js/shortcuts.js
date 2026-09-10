// Hmelj — keyboard shortcuts.
//
// Two traditions, both honoured, because people arrive here from both: Gmail's
// single letters (j/k to move, e to archive, r to reply) and Outlook's modifier
// combinations (Del to delete, Ctrl+Q to mark read, Ctrl+U to mark unread).
// Where the two disagree, the one that does not fight the browser wins — see
// the note on Ctrl+F below.
//
// ── What this file may and may not do ──────────────────────────────────────
// It owns no behaviour of its own. Every entry below calls the SAME function
// the corresponding menu entry calls, so a shortcut can never do something
// subtly different from the visible way of doing it — which is the failure mode
// that makes keyboard support untrustworthy rather than merely incomplete.
//
// ── Why the guard is the hard part ─────────────────────────────────────────
// A single-letter shortcut is only safe when the letter is not being typed at
// something. Three separate cases have to be excluded, and only the first is
// obvious:
//   1. the caret is in an input, textarea or contenteditable;
//   2. something modal is open (a dialog, compose, Settings, the attachment
//      viewer) — those own the keyboard while they are up;
//   3. the caret is inside the MESSAGE BODY, which is a sandboxed iframe with
//      its own document, so the keydown never reaches this listener at all.
//      messageFrame.js forwards those out as a postMessage; see onFrameKey.
/* global $, $$, state, quickToggleRead, quickDelete, quickRefile, refileFor,
   openMessage, closeMessage, navCollapseOneLevel, renderedRows, snoozeRow,
   Compose, Dialog, Settings, AttachmentViewer, Analytics, MessageFind, MessageFrame,
   I18n, toast, esc, openFolder, rowUids, listedFolderFor, showMessageMenu */

const Shortcuts = (() => {
  /**
   * Is a keystroke ours to take?
   *
   * Deliberately the same predicate for every binding, including the ones with
   * modifiers: Ctrl+Q while typing a subject should reach the subject, not mark
   * a message read behind the composer.
   */
  function busy() {
    const a = document.activeElement;
    if (a) {
      if (a.isContentEditable) return true;
      const tag = a.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    }
    // The same front-to-back order navCollapseOneLevel() documents — anything
    // on that list is on top of the message list and owns the keyboard.
    if (document.querySelector('.dialog-backdrop')) return true;
    if (document.querySelector('#theme-picker-backdrop')) return true;
    if (document.querySelector('.ctx-menu')) return true;
    if (typeof AttachmentViewer !== 'undefined' && AttachmentViewer.isOpen()) return true;
    if (typeof Compose !== 'undefined' && Compose.isOpen()) return true;
    if (typeof Settings !== 'undefined' && Settings.isOpen()) return true;
    if (typeof Analytics !== 'undefined' && Analytics.isOpen()) return true;
    if (typeof MessageFind !== 'undefined' && MessageFind.isOpen()) return true;
    return false;
  }

  /* ---------- the cursor ----------
   * A row that is FOCUSED without being open. state.openKey is the only such
   * notion the app had, and it means something else (this message is showing in
   * the reading pane), so j/k needs its own. Both hold a ROW KEY (app.js#
   * makeRowKey) — account, folder and uid — since a bare uid names a different
   * message in every mailbox the unified list mixes together.
   */

  /**
   * The rows on screen, as MESSAGE OBJECTS.
   *
   * app.js#renderedRows returns the message objects the list is drawn from, not
   * the <li> elements — it maps the DOM back through state.messages precisely so
   * callers do not have to touch the DOM. Treating them as elements is what this
   * file got wrong first time round: `r.dataset.key` on a plain object throws,
   * the throw was swallowed by handle()'s catch, and every shortcut that acts on
   * a message silently did nothing while `?` (which touches no rows) worked
   * perfectly — which made it look like the key map was fine.
   */
  const rows = () => (typeof renderedRows === 'function' ? renderedRows() : []);

  /** The <li> for a row key, for the two things that genuinely need the
   *  element: scrolling it into view, and positioning a menu over it. */
  function elFor(key) {
    for (const li of document.querySelectorAll('#msg-list .msg-row')) {
      if (li.dataset.key === String(key)) return li;
    }
    return null;
  }

  /** Where the keyboard is. Falls back to the OPEN message, so clicking a
   *  message and then pressing a key does the obvious thing without having to
   *  arrow onto it first, and to the first row when neither is set. */
  function current() {
    const all = rows();
    if (!all.length) return null;
    const want = String(state.cursorKey ?? state.openKey ?? '');
    return all.find((m) => rowKey(m) === want) || all[0];
  }

  function moveCursor(delta) {
    const all = rows();
    if (!all.length) return;
    const want = String(state.cursorKey ?? state.openKey ?? '');
    const at = all.findIndex((m) => rowKey(m) === want);
    // From nowhere, the first press lands on the first row rather than jumping
    // to the second — pressing "down" in a list with no cursor means "start".
    const next = at < 0 ? 0 : Math.min(all.length - 1, Math.max(0, at + delta));
    const m = all[next];
    if (!m) return;
    state.cursorKey = rowKey(m);
    paintCursor();
    // `nearest` rather than `center`: scrolling a row that is already visible
    // into the middle of the pane makes every keypress lurch the list.
    elFor(rowKey(m))?.scrollIntoView({ block: 'nearest' });
  }

  /** Draws the cursor without a re-render — the list is rebuilt often, and a
   *  full renderList() per keypress would be both slow and visibly flickery. */
  function paintCursor() {
    for (const li of document.querySelectorAll('#msg-list .msg-row')) {
      li.classList.toggle('cursor', li.dataset.key === String(state.cursorKey));
    }
  }

  /** Acts on the cursor row, then advances — the reason a keyboard user can
   *  clear a run of mail without ever looking at the list. */
  function actOnCursor(fn, { advance = true } = {}) {
    const m = current();
    if (!m) return;
    if (advance) {
      const all = rows();
      const at = all.findIndex((x) => rowKey(x) === rowKey(m));
      const next = all[at + 1] || all[at - 1];
      if (next) { state.cursorKey = rowKey(next); paintCursor(); }
    }
    fn(m);
  }

  /* ---------- the map ----------
   * `keys` are matched against a normalised description of the event:
   * "ctrl+q", "shift+/", "delete", "j". Every handler is a call into app.js.
   */
  const BINDINGS = [
    { keys: ['j', 'arrowdown'], help: 'Next message', run: () => moveCursor(1) },
    { keys: ['k', 'arrowup'], help: 'Previous message', run: () => moveCursor(-1) },
    { keys: ['enter', 'o'], help: 'Open', run: () => actOnCursor((m) => openMessage(m), { advance: false }) },
    { keys: ['u'], help: 'Back to the list', run: () => navCollapseOneLevel() },
    { keys: ['c'], help: 'Compose', run: () => Compose.open() },
    { keys: ['/'], help: 'Search', run: () => { const el = $('#search-input'); el?.focus(); el?.select(); } },

    // Outlook's, verbatim. Del is the one shortcut people try first without
    // being told it exists, and Ctrl+Q / Ctrl+U are muscle memory for anyone
    // who has used Outlook for a decade.
    { keys: ['delete', 'backspace', '#'], help: 'Delete', run: () => actOnCursor((m) => quickDelete(m)) },
    { keys: ['ctrl+q'], help: 'Mark as read', run: () => actOnCursor((m) => setRead(m, true), { advance: false }) },
    { keys: ['ctrl+u'], help: 'Mark as unread', run: () => actOnCursor((m) => setRead(m, false), { advance: false }) },

    { keys: ['e'], help: 'Archive', run: () => actOnCursor((m) => refileIfPossible(m, 'archive')) },
    { keys: ['!'], help: 'Mark as spam', run: () => actOnCursor((m) => refileIfPossible(m, 'junk')) },
    { keys: ['s'], help: 'Star', run: () => actOnCursor((m) => toggleStar(m), { advance: false }) },
    { keys: ['z'], help: 'Snooze', run: () => actOnCursor((m) => snoozeAtCursor(m), { advance: false }) },

    { keys: ['r'], help: 'Reply', run: () => replyFromCursor(false) },
    { keys: ['a'], help: 'Reply to all', run: () => replyFromCursor(true) },
    { keys: ['f'], help: 'Forward', run: () => forwardFromCursor() },

    { keys: ['?', 'shift+/'], help: 'This list', run: () => showHelp() },
  ];

  /* ---------- what the bindings call ---------- */

  // quickToggleRead flips; a shortcut that names a direction must not turn a
  // read message unread just because Ctrl+Q was pressed twice.
  function setRead(m, read) {
    const unread = typeof rowUnread === 'function' ? rowUnread(m) : !m.seen;
    if (unread === read) quickToggleRead(m);
  }

  function toggleStar(m) {
    // No exported helper for this one — the star is bound per row in buildRow,
    // so the honest way to fire the same code is to press the same button.
    elFor(rowKey(m))?.querySelector('.m-star')?.click();
  }

  /** Archive/spam are not available in every folder (an account may have no
   *  such folder, and you cannot archive from inside Archive). refileFor is
   *  what the menu asks; saying so is better than doing nothing. */
  function refileIfPossible(m, box) {
    const can = typeof refileFor === 'function' ? refileFor(m, box) : null;
    if (!can) return toast(I18n.t(box === 'junk' ? 'Nothing to mark as spam here' : 'Nothing to archive here'));
    quickRefile(m, box);
  }

  function snoozeAtCursor(m) {
    const li = elFor(rowKey(m));
    const r = li ? li.getBoundingClientRect() : { left: 80, bottom: 80 };
    // The picker is a context menu and needs somewhere to appear: the row it
    // was invoked on, so it behaves as if it had been right-clicked.
    snoozeRow(m, r.left + 40, r.bottom);
  }

  /* Reply/forward need the FETCHED message (body, headers, attachments), not
   * the list row, which carries only the envelope. From the list that means
   * opening it first — the same thing a person would do by hand, and it leaves
   * the message on screen behind the composer where they expect it. */
  async function withOpenMessage(fn) {
    const m = current();
    if (!m) return;
    const full = state.openMessage && String(state.openMessage.uid) === String(m.uid)
      ? state.openMessage
      : await openMessage(m).then(() => state.openMessage).catch(() => null);
    if (full) fn(full);
  }

  const replyFromCursor = (all) => withOpenMessage((full) => Compose.reply(full, all));
  const forwardFromCursor = () => withOpenMessage((full) => Compose.forward(full, full.__folder || state.currentFolder));

  /* ---------- the help overlay ----------
   * A shortcut nobody is told about might as well not exist, and this is the
   * only place the full list is written down for a reader rather than for a
   * parser.
   */
  function showHelp() {
    const rowsHtml = BINDINGS.map((b) => `<tr>
      <td class="kb-keys">${b.keys.map((k) => `<kbd>${esc(prettyKey(k))}</kbd>`).join(' ')}</td>
      <td>${esc(I18n.t(b.help))}</td></tr>`).join('');
    // Its own scroll region rather than relying on the dialog's: seventeen
    // bindings plus a hint is taller than a laptop window, and letting the
    // DIALOG scroll takes the OK button off screen with it.
    Dialog.alert('', {
      title: I18n.t('Keyboard shortcuts'),
      bodyHtml: `<div class="dialog-wide"><div class="kb-help-scroll"><table class="kb-help">${rowsHtml}</table></div>
        <div class="set-hint">${esc(I18n.t('Shortcuts are ignored while you are typing, and while a dialog or the composer is open.'))}</div></div>`,
    });
  }

  const KEY_LABELS = {
    arrowdown: '↓', arrowup: '↑', enter: '↵', delete: 'Del', backspace: '⌫',
    'ctrl+q': 'Ctrl+Q', 'ctrl+u': 'Ctrl+U', 'shift+/': '?',
  };
  const prettyKey = (k) => KEY_LABELS[k] || k.toUpperCase();

  /* ---------- the listener ---------- */

  /** "ctrl+q" / "delete" / "j" — a stable description of one keystroke.
   *  Meta is folded into ctrl so a Mac's Cmd+Q… is deliberately NOT: Cmd+Q
   *  quits the browser, and taking it would be hostile. Only the real Ctrl. */
  function describe(e) {
    const k = (e.key || '').toLowerCase();
    return (e.ctrlKey ? 'ctrl+' : '') + (e.shiftKey && k.length > 1 ? 'shift+' : '') + k;
  }

  function handle(e, { fromFrame = false } = {}) {
    // Alt is a menu accelerator on every platform; Meta belongs to the OS.
    if (e.altKey || e.metaKey) return false;
    if (!fromFrame && busy()) return false;
    // Only where there is a list to act on. The Calendar has its own map
    // (calendar.js), and the pseudo-folders hold nothing these can act on.
    if (typeof state === 'undefined' || !state.settings) return false;
    const desc = describe(e);
    const binding = BINDINGS.find((b) => b.keys.includes(desc));
    if (!binding) return false;
    // Ctrl+<letter> combinations that we DO claim have to be taken from the
    // browser explicitly; the single letters would otherwise do nothing anyway.
    e.preventDefault?.();
    // Caught so one broken binding cannot wedge the keyboard — but logged
    // loudly, because a silently swallowed throw here is exactly what made a
    // whole broken cursor layer look like "the key does nothing".
    try { binding.run(); } catch (err) { console.error(`Shortcut "${desc}" failed:`, err); }
    return true;
  }

  function init() {
    document.addEventListener('keydown', (e) => handle(e));
    // Keys pressed with the caret inside the message body land in the frame's
    // OWN document and never reach the listener above — messageFrame.js posts
    // them out. Without this, clicking into a message to read it silently turns
    // every shortcut off, which reads as them being broken rather than scoped.
    if (typeof MessageFrame !== 'undefined' && MessageFrame.onKeyMessage) {
      MessageFrame.onKeyMessage((detail) => handle(detail, { fromFrame: true }));
    }
    // The cursor is a class on a row, and the list is rebuilt constantly — put
    // it back after every render rather than making renderList know about it.
    document.addEventListener('hmelj:list-rendered', paintCursor);
  }

  return { init, handle, showHelp, paintCursor, BINDINGS };
})();
