// Hmelj — styled, promise-based dialogs replacing prompt()/confirm()/alert().
// All content is regular DOM, so the i18n observer translates it automatically.
const Dialog = (() => {
  // Every dialog currently on screen, innermost last — Dialog.* calls can nest
  // (compose's close prompt can open on top of the account wizard's form).
  // Only cancelTop() reads it, so the hardware back key can dismiss exactly the
  // topmost one, the same as its Escape key / backdrop tap would.
  const open = [];

  function build({ title, bodyHtml, buttons, expandable = false }) {
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop dialog-backdrop';
    // `expandable` adds a maximize toggle beside the title, for a dialog whose
    // content has no natural length — a meeting request's notes run to dial-in
    // numbers and a legal footer, and reading that through a 440px column is
    // most of a screen of scrolling.
    backdrop.innerHTML = `
      <div class="modal dialog" role="dialog" aria-modal="true">
        ${title || expandable ? `<div class="dialog-title">
          <span class="dialog-title-text">${title || ''}</span>
          ${expandable ? `<button type="button" class="dialog-expand icon-btn"
            aria-label="Expand" title="Expand">⤢</button>` : ''}
        </div>` : ''}
        <div class="dialog-body">${bodyHtml}</div>
        <div class="dialog-buttons"></div>
      </div>`;
    const btnRow = backdrop.querySelector('.dialog-buttons');
    for (const b of buttons) {
      const el = document.createElement('button');
      el.className = b.primary ? 'send-btn' : 'link-btn dialog-cancel';
      if (b.danger) el.classList.add('danger');
      el.textContent = b.label;
      el.dataset.value = b.value;
      btnRow.appendChild(el);
    }
    document.body.appendChild(backdrop);
    return backdrop;
  }

  function run(opts) {
    return new Promise((resolve) => {
      const backdrop = build(opts);
      const modal = backdrop.querySelector('.dialog');
      const input = backdrop.querySelector('input, textarea, select');

      // Remembered, so somebody who prefers the big one gets it every time
      // rather than clicking the same button on every event they open.
      const expand = backdrop.querySelector('.dialog-expand');
      if (expand) {
        const KEY = 'hmelj.dialogExpanded';
        const setMax = (on) => {
          modal.classList.toggle('dialog-max', on);
          expand.textContent = on ? '⤡' : '⤢';
          expand.title = on ? 'Restore' : 'Expand';
          expand.setAttribute('aria-label', expand.title);
        };
        let want = false;
        try { want = localStorage.getItem(KEY) === '1'; } catch { /* private mode */ }
        setMax(want);
        expand.addEventListener('click', () => {
          const on = !modal.classList.contains('dialog-max');
          setMax(on);
          try { localStorage.setItem(KEY, on ? '1' : '0'); } catch { /* nothing to do */ }
        });
      }
      const finish = (value) => {
        backdrop.remove();
        const i = open.indexOf(entry);
        if (i !== -1) open.splice(i, 1);
        resolve(value);
      };
      const entry = { cancel: () => finish(null) };
      open.push(entry);

      // 'ok' resolves the dialog's own value (getValue / true), 'cancel'
      // resolves null; any other value resolves as itself, which is what lets
      // choose() below offer more than the two standard outcomes.
      backdrop.querySelectorAll('.dialog-buttons button').forEach((b) =>
        b.addEventListener('click', () => {
          const v = b.dataset.value;
          if (v === 'ok') finish(opts.getValue ? opts.getValue(backdrop) : true);
          else if (v === 'cancel') finish(null);
          else finish(v);
        }));
      // Both ends on the backdrop, not just the press. Selecting an address out
      // of an event's notes and releasing past the edge of the dialog is a drag
      // that ENDS on the backdrop — closing there throws away the selection and
      // the dialog with it, which is what makes text look uncopyable.
      let pressedBackdrop = false;
      backdrop.addEventListener('mousedown', (e) => { pressedBackdrop = e.target === backdrop; });
      backdrop.addEventListener('mouseup', (e) => {
        if (pressedBackdrop && e.target === backdrop) finish(null);
        pressedBackdrop = false;
      });
      modal.addEventListener('keydown', (e) => {
        // stopPropagation, because this keypress is now SPENT. finish() removes
        // the backdrop synchronously, but the event carries on along the path
        // it was dispatched with — so a document-level Escape handler further
        // out still runs, and its "is a dialog open?" guard now finds nothing.
        // That is not theoretical: compose's own close prompt IS one of these,
        // so Escape cancelled the prompt and compose's handler immediately
        // reopened it.
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(null); }
        if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA') {
          e.preventDefault();
          finish(opts.getValue ? opts.getValue(backdrop) : true);
        }
      });
      // After the DOM is in place and before focus: a form whose fields depend
      // on each other — the calendar's all-day toggle, which decides whether
      // the date inputs are dates or date-times — has no other moment to bind
      // in, and getValue() runs only when it is already too late.
      try { opts.onOpen?.(backdrop); } catch (e) { console.warn('dialog onOpen failed', e); }

      (input || backdrop.querySelector('.dialog-buttons button')).focus();
      if (input && input.select) input.select();
    });
  }

  /** Text input. Resolves with the string, or null when cancelled/empty. */
  function prompt(title, { label = '', value = '', placeholder = '', hint = '' } = {}) {
    return run({
      title,
      bodyHtml: `
        ${label ? `<label class="dialog-label">${label}</label>` : ''}
        <input class="dialog-input" type="text" value="${esc(value)}" placeholder="${esc(placeholder)}">
        ${hint ? `<div class="set-hint">${hint}</div>` : ''}`,
      buttons: [{ label: 'Cancel', value: 'cancel' }, { label: 'OK', value: 'ok', primary: true }],
      getValue: (root) => root.querySelector('.dialog-input').value.trim() || null,
    });
  }

  /** Confirmation. Resolves true / null. `danger` styles the OK button red. */
  function confirm(message, { title = '', okLabel = 'OK', danger = false } = {}) {
    return run({
      title,
      bodyHtml: `<div class="dialog-message">${esc(message)}</div>`,
      buttons: [{ label: 'Cancel', value: 'cancel' }, { label: okLabel, value: 'ok', primary: true, danger }],
    }).then((v) => (v ? true : null));
  }

  /** `bodyHtml` for a caller with real markup to show — the app password, which
   *  is a field to copy out of rather than a sentence. Only one of the two is
   *  ever used, and `message` is escaped; `bodyHtml` is not, so it must never
   *  carry anything a user typed. */
  function alert(message, { title = '', bodyHtml = null, onOpen = null } = {}) {
    return run({
      title,
      onOpen,
      bodyHtml: bodyHtml ?? `<div class="dialog-message">${esc(message)}</div>`,
      buttons: [{ label: 'OK', value: 'ok', primary: true }],
    });
  }

  /** Three-or-more-way choice, for the cases confirm()'s single OK can't
   * express (compose's close prompt: save the draft, delete it, or go back to
   * editing). Cancel is prepended automatically and resolves null — the same
   * result as Escape, a backdrop tap, or the hardware back key — so callers
   * only pass the affirmative buttons and only ever have to handle their own
   * values. Enter picks the primary one. */
  /**
   * A question with more than two answers.
   *
   * `bodyHtml` replaces the escaped `message` for a caller that has real markup
   * to show — the calendar's event details, which are a list of labelled rows
   * rather than a sentence. Only one of the two is ever used, and `message`
   * stays the default so the escaping is what a caller gets without asking.
   */
  function choose(message, { title = '', buttons = [], bodyHtml = null, expandable = false } = {}) {
    const primary = buttons.find((b) => b.primary);
    return run({
      title,
      bodyHtml: bodyHtml ?? `<div class="dialog-message">${esc(message)}</div>`,
      buttons: [{ label: 'Cancel', value: 'cancel' }, ...buttons],
      expandable,
      getValue: () => primary?.value ?? null,
    });
  }

  /** Dismisses the topmost open dialog exactly as cancelling it would, and
   * reports whether there was one — the hardware back key's first collapse
   * level (see app.js's navCollapseOneLevel). */
  function cancelTop() {
    const top = open[open.length - 1];
    if (!top) return false;
    top.cancel();
    return true;
  }

  /** Arbitrary form dialog: bodyHtml + getValue(root). Used by the account wizard. */
  function form(title, bodyHtml, { okLabel = 'Save', getValue, wide = false, onOpen = null } = {}) {
    return run({ title, onOpen, bodyHtml: wide ? `<div class="dialog-wide">${bodyHtml}</div>` : bodyHtml,
      buttons: [{ label: 'Cancel', value: 'cancel' }, { label: okLabel, value: 'ok', primary: true }],
      getValue });
  }

  function esc(s) { const d = document.createElement('div'); d.textContent = s ?? ''; return d.innerHTML; }

  return { prompt, confirm, alert, form, choose, cancelTop };
})();

/** UUID that also works on plain-HTTP origins where crypto.randomUUID is unavailable. */
function uid() {
  if (window.crypto?.randomUUID) return crypto.randomUUID();
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
