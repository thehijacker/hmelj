// Hmelj — styled, promise-based dialogs replacing prompt()/confirm()/alert().
// All content is regular DOM, so the i18n observer translates it automatically.
const Dialog = (() => {
  // Every dialog currently on screen, innermost last — Dialog.* calls can nest
  // (compose's close prompt can open on top of the account wizard's form).
  // Only cancelTop() reads it, so the hardware back key can dismiss exactly the
  // topmost one, the same as its Escape key / backdrop tap would.
  const open = [];

  function build({ title, bodyHtml, buttons }) {
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop dialog-backdrop';
    backdrop.innerHTML = `
      <div class="modal dialog" role="dialog" aria-modal="true">
        ${title ? `<div class="dialog-title">${title}</div>` : ''}
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
      backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) finish(null); });
      modal.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') finish(null);
        if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA') {
          e.preventDefault();
          finish(opts.getValue ? opts.getValue(backdrop) : true);
        }
      });
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

  function alert(message, { title = '' } = {}) {
    return run({
      title,
      bodyHtml: `<div class="dialog-message">${esc(message)}</div>`,
      buttons: [{ label: 'OK', value: 'ok', primary: true }],
    });
  }

  /** Three-or-more-way choice, for the cases confirm()'s single OK can't
   * express (compose's close prompt: save the draft, delete it, or go back to
   * editing). Cancel is prepended automatically and resolves null — the same
   * result as Escape, a backdrop tap, or the hardware back key — so callers
   * only pass the affirmative buttons and only ever have to handle their own
   * values. Enter picks the primary one. */
  function choose(message, { title = '', buttons = [] } = {}) {
    const primary = buttons.find((b) => b.primary);
    return run({
      title,
      bodyHtml: `<div class="dialog-message">${esc(message)}</div>`,
      buttons: [{ label: 'Cancel', value: 'cancel' }, ...buttons],
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
  function form(title, bodyHtml, { okLabel = 'Save', getValue, wide = false } = {}) {
    return run({ title, bodyHtml: wide ? `<div class="dialog-wide">${bodyHtml}</div>` : bodyHtml,
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
