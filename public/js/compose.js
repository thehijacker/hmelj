// Hmelj — compose window
const Compose = (() => {
  // Specific named faces here, NOT the generic keywords the app's own UI/message
  // fonts use (GENERIC_FONTS in app.js): this list ends up as font-family in mail
  // somebody ELSE opens, where "Georgia" is a convention every client understands
  // and "serif" would be answered by whatever that client felt like.
  const FONTS = ['system-ui', 'Arial', 'Georgia', 'Verdana', 'Tahoma', 'Trebuchet MS', 'Times New Roman', 'Courier New', 'Roboto', 'Open Sans'];
  // What each of those becomes in the sent HTML — the named face plus a fallback,
  // so a recipient without it still lands somewhere close instead of on their
  // client's default. 'system-ui' maps to nothing on purpose: it means "no
  // opinion", and the absence of a font-family is what actually lets the message
  // render in the reader's own preferred font.
  const FONT_STACK = {
    'system-ui': '',
    Arial: 'Arial, Helvetica, sans-serif',
    Georgia: 'Georgia, serif',
    Verdana: 'Verdana, Geneva, sans-serif',
    Tahoma: 'Tahoma, Geneva, sans-serif',
    'Trebuchet MS': "'Trebuchet MS', Helvetica, sans-serif",
    'Times New Roman': "'Times New Roman', Times, serif",
    'Courier New': "'Courier New', Courier, monospace",
    Roboto: 'Roboto, Arial, sans-serif',
    'Open Sans': "'Open Sans', Arial, sans-serif",
  };
  // The two structural wrappers open() builds a body out of. Everything the user
  // writes goes inside .compose-body; the quoted original (and a forward's
  // "---------- Forwarded message ----------" divider) inside .quoted-block.
  //
  // They exist for two jobs that both need to know where the user's own text ends:
  //  - the signature, which used to be appended to the very end of the editor and
  //    so landed UNDERNEATH the quoted message on every reply and forward (the
  //    reported bug) instead of under what the user just wrote;
  //  - the default compose font, which must style the user's own writing without
  //    restyling mail they are only quoting.
  // Both classes travel into the sent HTML, same as .signature-wrap and
  // .quote-header already did.
  const BODY_CLASS = 'compose-body';
  const QUOTE_CLASS = 'quoted-block';
  // What signatureHtml() wraps a signature in: ONE node, so switching identity
  // removes the whole thing, spacing included — and so a signature already in
  // the body (a reopened draft) can be recognised rather than duplicated.
  const SIGNATURE_WRAP = 'signature-wrap';
  let identities = [];
  // {filename, contentType, contentBase64} — plus {cid, inline:true} for an
  // image pasted or dropped into the body, which travels as a normal
  // attachment referenced by <img src="cid:…">. server/smtpClient.js has
  // always passed `cid` through (it was written for a filter's redirect); the
  // composer simply never set it before.
  let attachments = [];
  let draftUid = null;
  let replyMeta = null; // {inReplyTo, references, original} — `original` is {accountId, folder, uid, kind}, see markOriginal below
  // Recipients HMELJ put in the To/Cc fields, not the user — today only a
  // reply's (and reply-all's) addresses. They are excluded from the automatic
  // "people I write to become contacts" (server/contacts.js): answering
  // somebody is not the same act as deciding to write to them, and an address
  // book that filled up with everyone who has ever mailed you is exactly what
  // that feature is built to avoid. A draft's recipients are NOT in here — the
  // user typed those, just in an earlier sitting.
  let prefilledRecipients = [];
  let autosaveTimer = null;
  let dirty = false;
  let pristinePayload = null; // JSON snapshot of payload() as of the last successful save, or right after open() if there hasn't been one yet
  let composeContext = 'new'; // context passed to open() ('new' | 'reply') — re-used by applySignatureForIdentity when the From identity changes mid-compose, so a signature configured "new messages only" still respects that on a reply/forward
  let insertedSignatureNode = null; // rich mode: the actual DOM node last auto-inserted by applySignatureForIdentity, so switching identity can cleanly remove it — null if none, or if the user may have edited/removed it (see applySignatureForIdentity)
  let insertedSignaturePlainText = ''; // plain mode: the exact text last auto-inserted, same purpose
  let plainQuoteTail = ''; // plain mode: the quoted original's text, as it sits at the END of the textarea — see quotedTailText
  let inFlightSave = null; // the Promise from a saveDraftNow() currently in flight, or null — see requestClose/discardDraft
  let closing = false; // a requestClose() is already deciding (awaiting an in-flight save, or with its prompt up) — see requestClose

  const el = () => document.getElementById('compose-window');

  function setIdentities(list) {
    identities = list;
    const sel = document.getElementById('c-identity');
    const opt = (i) => `<option value="${i.id}" ${i.default ? 'selected' : ''}>${esc(i.name || '')} &lt;${esc(i.email)}&gt;${i.organization ? ' — ' + esc(i.organization) : ''}</option>`;
    const groups = (state.accounts || []).map((a) => ({ account: a, items: list.filter((i) => i.accountId === a.id) })).filter((g) => g.items.length);
    const orphans = list.filter((i) => !(state.accounts || []).some((a) => a.id === i.accountId));
    sel.innerHTML = groups.map((g) => `<optgroup label="${escAttr(g.account.label)}">${g.items.map(opt).join('')}</optgroup>`).join('')
      + (orphans.length ? `<optgroup label="${escAttr(I18n.t('Other'))}">${orphans.map(opt).join('')}</optgroup>` : '');
  }

  function currentIdentity() {
    return identities.find((i) => i.id === document.getElementById('c-identity').value) || identities[0] || {};
  }

  /** Best identity for a given mail account: its own default, else its
   * auto-created main identity (id === accountId), else its first identity. */
  function identityForAccount(accountId) {
    if (!accountId) return null;
    const forAcct = identities.filter((i) => i.accountId === accountId);
    return forAcct.find((i) => i.default) || forAcct.find((i) => i.id === accountId) || forAcct[0] || null;
  }

  /** Compose's default From: the current account's identity if a specific
   * account is open, else the last specific account visited (relevant when
   * composing from "All inboxes"), else the global default identity. */
  function defaultIdentityId() {
    const acctId = state.currentAccount && state.currentAccount !== 'all' ? state.currentAccount : state.lastAccount;
    const forAcct = acctId && identityForAccount(acctId);
    return (forAcct || identities.find((i) => i.default) || identities[0])?.id;
  }

  function isPlain() { return document.getElementById('c-plain').checked; }

  function setBodyHtml(html) {
    document.getElementById('c-editor').innerHTML = html;
  }
  function getBody() {
    if (isPlain()) {
      const text = document.getElementById('c-editor-plain').value;
      return { text, html: null };
    }
    const ed = document.getElementById('c-editor');
    // Worked on a CLONE: rewriting the live editor would move the caret and
    // replace the images the user is looking at, and getBody() runs on every
    // autosave, not just on send.
    const out = ed.cloneNode(true);
    for (const img of out.querySelectorAll('img[data-hmelj-cid]')) {
      img.setAttribute('src', 'cid:' + img.getAttribute('data-hmelj-cid'));
      img.removeAttribute('data-hmelj-cid');
    }
    // An inline image the user has since deleted from the body would otherwise
    // still be sent — invisible, but counted against the message size and
    // shown as an attachment by the receiving client.
    const stillUsed = new Set([...ed.querySelectorAll('img[data-hmelj-cid]')].map((i) => i.getAttribute('data-hmelj-cid')));
    const orphans = attachments.filter((a) => a.inline && !stillUsed.has(a.cid));
    if (orphans.length) {
      attachments = attachments.filter((a) => !a.inline || stillUsed.has(a.cid));
      renderAttachments();
    }
    // A URL typed into a contenteditable is just characters — the browser does
    // not link it, and neither did we, so "…v management programu:
    // http://host/x" went out as text the RECIPIENT could not click either.
    // Linked here, on the way out, rather than as you type: rewriting the
    // editor's own DOM mid-sentence moves the caret, which is why no client
    // does it that way. target="_blank" is dropped — it means nothing in mail.
    // Nothing to link (the usual case, since URLs in the signature and the
    // quoted block are already anchors) returns the same string untouched.
    return { html: MessageFrame.linkifyBareUrlsInHtml(out.innerHTML, { target: false }), text: ed.innerText };
  }

  /** The default font for new mail (Settings > Compose > Default font), as a CSS
   *  font-family value — '' for "system-ui", which means don't specify one. */
  function defaultFontCss() {
    return FONT_STACK[state.settings?.composeFont] || '';
  }

  /** The user's own writing area: one .compose-body div carrying the default font,
   *  wrapping `inner`. Kept a single element so applySignatureForIdentity can find
   *  it with one selector and so the quoted original stays outside it. */
  function freshBody(inner = '<div><br></div>') {
    const css = defaultFontCss();
    return `<div class="${BODY_CLASS}"${css ? ` style="font-family:${escAttr(css)}"` : ''}>${inner}</div>`;
  }

  /** The plain-text tail that htmlToText() renders for a TRAILING .quoted-block,
   *  or '' when the quote isn't at the end (quote-above) or there isn't one.
   *  Plain-text mode has no DOM to insert into, so this is how the signature finds
   *  the same spot there — above the quote — that the rich editor puts it in.
   *  Exact rather than approximate: the quoted block is a literal suffix of the
   *  body HTML, so running the same htmlToText over just that suffix produces
   *  exactly the substring the textarea ends with. */
  function quotedTailText(html) {
    const d = document.createElement('div');
    d.innerHTML = html || '';
    const q = d.lastElementChild;
    if (!q || !q.classList.contains(QUOTE_CLASS)) return '';
    return htmlToText(q.outerHTML);
  }

  function signatureHtml(id, context /* new | reply */) {
    if (!id?.signature) return '';
    const on = id.signatureOn || 'new-reply'; // new | new-reply | always | never
    if (on === 'never') return '';
    if (on === 'new' && context !== 'new') return '';
    // Signatures written with the old plain-text editor still have literal
    // `\n` line breaks and need converting; ones from the newer rich HTML
    // editor (Settings > Identities) already contain real markup and should
    // pass through untouched.
    const body = /<[a-z][\s\S]*>/i.test(id.signature) ? id.signature : id.signature.replace(/\n/g, '<br>');
    // The "-- " (dash-dash-space) delimiter is a long-standing email
    // convention (RFC 3676) — some mail clients use it to auto-strip a
    // signature when quoting on reply, and lightly de-emphasize text after
    // it. Per-identity opt-out (defaults on, so existing identities from
    // before this setting existed keep behaving exactly as they already did).
    const delimiter = id.signatureDelimiter !== false ? '-- <br>' : '';
    // One wrapping div (not bare <br><br> + a sibling .signature div) so
    // applySignatureForIdentity can remove the whole thing — spacing and
    // all — as a single node when switching identities.
    return `<div class="${SIGNATURE_WRAP}"><br><br><div class="signature">${delimiter}${body}</div></div>`;
  }

  /** Inserts (or removes, if the newly-selected identity's own settings say
   * not to add one) the signature for `id`/`context` — called both by
   * open() for the initial insert and by the From/identity <select>'s
   * change handler, so switching identity mid-compose actually swaps the
   * signature instead of leaving whichever one was there when the window
   * first opened (the reported bug).
   *
   * Only ever touches a signature IT most recently inserted (tracked via
   * insertedSignatureNode/insertedSignaturePlainText) — if the user has
   * since edited or deleted it, this leaves their content alone rather than
   * silently clobbering it; the new identity's signature is still appended
   * after whatever's there, just without removing anything first. */
  function applySignatureForIdentity(id, context) {
    const sig = signatureHtml(id, context);
    // A body that ALREADY carries a signature is a message coming back to be
    // edited — a draft reopened, or a cancelled undo-send. The one it has is
    // the one its author saved, so it is adopted rather than added to; without
    // this, open() appended a second copy every time a draft was reopened, and
    // a third the time after that.
    //
    // Adopted, not merely skipped: `insertedSignatureNode` is what lets a later
    // identity switch replace the signature instead of stacking another one
    // under it, and after a reopen that pointer would otherwise be null.
    if (adoptExistingSignature()) return;
    if (isPlain()) {
      const ta = document.getElementById('c-editor-plain');
      const text = ta.value;
      // Split the quoted original off the end first, so everything below happens
      // to the user's own text only and the signature goes above the quote. If
      // they've edited down in the quote the endsWith fails and `tail` is empty,
      // which degrades to exactly what this did before: append at the very end.
      const tail = plainQuoteTail && text.endsWith(plainQuoteTail) ? plainQuoteTail : '';
      let head = tail ? text.slice(0, text.length - tail.length) : text;
      if (insertedSignaturePlainText && head.endsWith(insertedSignaturePlainText)) {
        head = head.slice(0, head.length - insertedSignaturePlainText.length);
      }
      const sigPlain = sig ? htmlToText(sig) : '';
      ta.value = head + sigPlain + tail;
      insertedSignaturePlainText = sigPlain;
      insertedSignatureNode = null;
    } else {
      const ed = document.getElementById('c-editor');
      if (insertedSignatureNode?.isConnected) insertedSignatureNode.remove();
      insertedSignatureNode = null;
      if (sig) {
        // Into the writing area, not the editor root — that is the whole point of
        // .compose-body. Falls back to the root for a body that has no wrapper:
        // a draft saved before this existed, reopened with editDraft().
        const host = ed.querySelector(`:scope > .${BODY_CLASS}`) || ed;
        host.insertAdjacentHTML('beforeend', sig);
        insertedSignatureNode = host.lastElementChild;
      }
      insertedSignaturePlainText = '';
    }
  }

  /**
   * Claims a signature that is already in the body, if this call has not put
   * one there itself yet. Returns true when there was one.
   *
   * Scoped to the writing area's direct children on purpose: a reply quotes an
   * original that may well end with the sender's own signature block, and that
   * one belongs to them and to the quote, not to this message.
   */
  function adoptExistingSignature() {
    if (isPlain()) {
      if (insertedSignaturePlainText) return false; // this compose already placed one
      const ta = document.getElementById('c-editor-plain');
      const tail = plainQuoteTail && ta.value.endsWith(plainQuoteTail) ? plainQuoteTail : '';
      const head = tail ? ta.value.slice(0, ta.value.length - tail.length) : ta.value;
      // Plain text has no markup to recognise, so the delimiter convention is
      // the only signal there is: "-- " on a line of its own (RFC 3676).
      const at = head.search(/(^|\n)-- \n/);
      if (at < 0) return false;
      insertedSignaturePlainText = head.slice(at === 0 ? 0 : at + 1);
      return true;
    }
    if (insertedSignatureNode?.isConnected) return false; // ditto
    const ed = document.getElementById('c-editor');
    const host = ed.querySelector(`:scope > .${BODY_CLASS}`) || ed;
    const existing = host.querySelector(`:scope > .${SIGNATURE_WRAP}`);
    if (!existing) return false;
    insertedSignatureNode = existing;
    insertedSignaturePlainText = '';
    return true;
  }

  /* ---------- templates (Settings > Templates) ----------
   * Reusable boilerplate, inserted at the caret. Stored as HTML because that is
   * what the rich composer needs; plain mode flattens it on the way in rather
   * than a second copy being kept and drifting from the first.
   */
  let templates = [];

  /** Called at boot and after Settings saves. Hides the toolbar button entirely
   *  when there is nothing to insert — an always-visible button that opens an
   *  empty menu is worse than no button. */
  function setTemplates(list) {
    templates = Array.isArray(list) ? list : [];
    const btn = document.getElementById('c-template');
    if (btn) btn.hidden = !templates.length;
  }

  /**
   * Inserts one at the caret, or at the end of the user's own text when the
   * caret is somewhere else (in the quoted original, or nowhere at all).
   *
   * `.compose-body` again, for the same reason applySignatureForIdentity uses
   * it: that wrapper is the only thing that knows where what the user is
   * writing ends and the quoted conversation begins.
   */
  function insertTemplate(t) {
    if (!t) return;
    if (isPlain()) {
      const ta = document.getElementById('c-editor-plain');
      const plain = htmlToText(t.html || '');
      const tail = plainQuoteTail && ta.value.endsWith(plainQuoteTail) ? plainQuoteTail : '';
      const head = tail ? ta.value.slice(0, ta.value.length - tail.length) : ta.value;
      // At the caret when it is in the user's own text; otherwise at the end of it.
      const at = (ta.selectionStart != null && ta.selectionStart <= head.length) ? ta.selectionStart : head.length;
      ta.value = head.slice(0, at) + plain + head.slice(at) + tail;
      ta.focus();
      ta.selectionStart = ta.selectionEnd = at + plain.length;
    } else {
      const ed = document.getElementById('c-editor');
      const host = ed.querySelector(`:scope > .${BODY_CLASS}`) || ed;
      const sel = window.getSelection();
      const inBody = sel?.rangeCount && host.contains(sel.getRangeAt(0).commonAncestorContainer);
      if (inBody) {
        ed.focus();
        document.execCommand('insertHTML', false, t.html || '');
      } else {
        // Before the signature if there is one, so a template never lands under
        // the sign-off.
        const sig = host.querySelector(`:scope > .${SIGNATURE_WRAP}`);
        const frag = document.createElement('div');
        frag.innerHTML = t.html || '';
        if (sig) sig.insertAdjacentHTML('beforebegin', frag.innerHTML);
        else host.insertAdjacentHTML('beforeend', frag.innerHTML);
      }
    }
    dirty = true;
  }

  function showTemplateMenu(x, y) {
    if (!templates.length) return;
    openCtxMenu(templates.map((t) => ({
      // The user's own words: not run through I18n. openCtxMenu translates its
      // labels, and a template called "Ponudba" must not be looked up.
      label: t.name,
      onClick: () => insertTemplate(t),
    })), x, y);
  }

  function open({ to = '', cc = '', subject = '', bodyHtml = '', context = 'new', identityId = null } = {}) {
    const w = el();
    w.hidden = false;
    w.classList.remove('minimized');
    attachments = [];
    draftUid = null;
    replyMeta = null;
    prefilledRecipients = [];
    dirty = false;
    // Mobile opens straight into the enlarged (full-page) state — a 560px
    // floating panel pinned bottom-right is unusable on a phone, and
    // .compose-window.large already means "full page size" inside the 900px
    // media query (see app.css). Desktop keeps the small floating window and
    // the enlarge button toggles either one back the other way.
    el().classList.toggle('large', matchMedia('(max-width: 900px)').matches);
    closeContactSuggest();
    renderAttachments();
    const idSel = document.getElementById('c-identity');
    const wantId = identityId || defaultIdentityId();
    if (wantId && idSel.querySelector(`option[value="${CSS.escape(wantId)}"]`)) idSel.value = wantId;
    document.getElementById('c-to').value = to;
    document.getElementById('c-cc').value = cc;
    document.getElementById('c-bcc').value = '';
    document.getElementById('c-subject').value = subject;
    document.getElementById('c-priority').value = 'normal';
    document.getElementById('c-receipt').checked = !!state.settings.requestReadReceipt;
    document.getElementById('compose-title').textContent = subject || 'New message';
    document.getElementById('draft-status').textContent = '';
    const plain = state.settings.composeFormat === 'plain';
    document.getElementById('c-plain').checked = plain;
    togglePlain(plain, false);
    composeContext = context;
    insertedSignatureNode = null;
    insertedSignaturePlainText = '';
    if (plain) {
      document.getElementById('c-editor-plain').value = htmlToText(bodyHtml);
      plainQuoteTail = quotedTailText(bodyHtml);
    } else {
      setBodyHtml(bodyHtml || freshBody());
      plainQuoteTail = '';
    }
    // The toolbar's font <select> and the editor's own display font both survive
    // between compose windows (the elements are reused, never rebuilt), so without
    // this a font picked in one message silently carried over to the next one —
    // visibly, and yet not actually in that message's HTML. Reset both to the
    // configured default, whose real effect lives in freshBody()'s wrapper.
    applyDefaultFont();
    // Appends the current identity's signature (if its own settings call
    // for one in this context) — same path the From <select>'s change
    // handler below uses to swap it when the identity changes mid-compose.
    applySignatureForIdentity(currentIdentity(), context);
    startAutosave();
    (to ? document.getElementById('c-subject') : document.getElementById('c-to')).focus();
    // Deferred one tick: reply()/forward() call open() and then set replyMeta
    // synchronously right after it returns — capturing the pristine snapshot
    // inside open() itself would miss those fields and make an untouched
    // reply/forward always look "changed" relative to its own baseline.
    setTimeout(() => { pristinePayload = JSON.stringify(payload()); }, 0);
    // After the body is populated, so the first check sees the real text — and
    // late enough that the signature is already in place to be skipped.
    Proofread.open({ plain });
  }

  function htmlToText(html) {
    const d = document.createElement('div');
    d.innerHTML = (html || '').replace(/<br\s*\/?>(?!$)/gi, '\n').replace(/<\/(div|p|blockquote)>/gi, '\n');
    return d.textContent;
  }

  function quoteBlock(msg) {
    const when = fmtDate(msg.date, { long: true });
    const who = msg.from?.[0] ? (msg.from[0].name || msg.from[0].address) : '';
    // Same linkifying the reading pane does (MessageFrame.linkifyText): a
    // plain-text original quoted into an HTML reply keeps its URLs clickable
    // for whoever reads the reply, instead of quietly demoting them to text.
    // Only quoted mail — editDraft() below deliberately leaves the user's own
    // draft byte-for-byte as they wrote it.
    const inner = msg.html || `<pre>${MessageFrame.linkifyText(msg.text)}</pre>`;
    return `<br><div class="quote-header">On ${esc(when)}, ${esc(who)} wrote:</div>
<blockquote style="margin:0 0 0 8px;padding-left:10px;border-left:2px solid #8ab4f8;color:inherit">${inner}</blockquote>`;
  }

  /** `pos` defaults to the reply setting but is passed explicitly by forward(),
   *  which must always carry the original: "do not quote" is an answer about
   *  replies, and a forward with nothing forwarded is not a message. */
  function withQuote(msg, lead = '', pos = state.settings.replyQuotePosition) {
    const fresh = freshBody();
    if (pos === 'none') return fresh;
    const quoted = `<div class="${QUOTE_CLASS}">${lead}${quoteBlock(msg)}</div>`;
    if (pos === 'above') return quoted + '<br>' + fresh;
    return fresh + quoted;
  }

  async function reply(msg, all) {
    const from = msg.replyTo?.length ? msg.replyTo : msg.from;
    const to = (from || []).map((a) => a.address).join(', ');
    // Computed whether or not `all` is set: it costs nothing (the reply-all
    // branch below builds the same expression), and knowing WHO would be added
    // is the only way to ask a useful question about a plain Reply.
    // ownAddresses() rather than the identity list alone — it also covers the
    // account addresses, and a reply to a message addressed to one of those
    // would otherwise look like it had a stranger on it.
    const others = ComposeGuards.replyAllWouldAdd({
      to: msg.to, cc: msg.cc, replyingTo: from,
      mine: ownAddresses().map((o) => o.email),
    });
    if (!all && others.length && state.settings.replyAllNudge !== false) {
      const answer = await Dialog.choose(
        I18n.t('{n} other people are on this message.').replace('{n}', others.length),
        {
          title: I18n.t('Reply'),
          buttons: [
            { label: I18n.t('Reply to sender only'), value: 'one' },
            { label: I18n.t('Reply to all'), value: 'all', primary: true },
          ],
        },
      );
      if (!answer) return;        // cancelled — write nothing
      if (answer === 'all') all = true;
    }
    let cc = '';
    if (all) {
      const mine = new Set(identities.map((i) => i.email.toLowerCase()));
      cc = [...msg.to, ...msg.cc].map((a) => a.address).filter((a) => a && !mine.has(a.toLowerCase()) && a !== to).join(', ');
    }
    open({
      to, cc,
      subject: /^re:/i.test(msg.subject) ? msg.subject : 'Re: ' + msg.subject,
      bodyHtml: withQuote(msg),
      context: 'reply',
      identityId: identityForAccount(msg.__account)?.id,
    });
    replyMeta = {
      inReplyTo: msg.messageId,
      references: [msg.references, msg.messageId].flat().filter(Boolean).join(' '),
      original: originalRef(msg, 'reply'),
    };
    // Set after open(), which clears it. Everything the user adds on top of
    // these still counts as theirs and is still learned.
    prefilledRecipients = [to, cc].filter(Boolean);
  }

  /**
   * Where the message being answered actually lives, so the server can mark it
   * \Answered / $Forwarded once the send succeeds and every other mail client
   * shows the same ↩ / ↪ against it (see index.js#markOriginal).
   *
   * The account matters as much as the folder: replying to mail in one account
   * while sending from another identity is ordinary, and the mark belongs on the
   * ORIGINAL's account, not the sending one. `msg.__account` is null in a
   * single-account view — the server reads that as "the one this request names".
   */
  function originalRef(msg, kind) {
    if (!msg || msg.uid == null) return undefined;
    const folder = msg.__folder || state.currentFolder;
    if (!folder || folder.startsWith('__')) return undefined; // a smart folder is not a real mailbox
    return { accountId: msg.__account || API.account, folder, uid: msg.uid, kind };
  }

  function forward(msg, folder) {
    open({
      subject: /^fwd?:/i.test(msg.subject) ? msg.subject : 'Fwd: ' + msg.subject,
      // The divider belongs to the quoted part, not to what the user is writing:
      // inside .quoted-block it stays put when the signature goes in above it.
      bodyHtml: withQuote(msg, '<div>---------- Forwarded message ----------</div>', 'below'),
      context: 'reply',
      identityId: identityForAccount(msg.__account)?.id,
    });
    // Only the `original` half, deliberately: a forward is a NEW thread, so it
    // must not carry In-Reply-To/References the way a reply does — but the
    // message being forwarded still gets its $Forwarded mark. Set after open(),
    // which clears replyMeta, and before the deferred pristine snapshot picks it up.
    replyMeta = { original: originalRef({ ...msg, __folder: folder || msg.__folder }, 'forward') };
    // Carry over real attachments only — not ones already embedded in the
    // quoted body above via a cid: reference (msg.html, included by
    // quoteBlock()). Those already show up inline in the forwarded content;
    // re-attaching them too was showing every inline image twice: once
    // inline (correct) and once again as a separate attachment chip, sent
    // out as a real duplicate MIME part. Same inlineUsed check the message
    // view itself already uses to decide what counts as a real attachment
    // (see app.js's `msg.attachments.filter((a) => !a.inlineUsed)`).
    for (const a of msg.attachments || []) {
      if (a.inlineUsed) continue;
      fetch(`/api/message/${encodeURIComponent(folder)}/${encodeURIComponent(msg.uid)}/attachment/${a.index}`)
        .then((r) => r.blob()).then((b) => addBlob(b, a.filename, a.contentType));
    }
  }

  /**
   * Reopens a message that had been parked somewhere — today only the scheduled
   * queue (app.js#openScheduled). Restores everything payload() serialises, so
   * a cancelled scheduled message comes back byte-identical to what was queued
   * rather than as a lossy approximation of it.
   */
  function reopen(p) {
    open({
      to: p.to || '',
      cc: p.cc || '',
      subject: p.subject || '',
      bodyHtml: p.html || (p.text ? `<div>${esc(p.text).replace(/\n/g, '<br>')}</div>` : ''),
      context: 'new',
      identityId: p.identityId || null,
    });
    // Everything open() doesn't take as an argument, and the two fields it
    // deliberately resets (attachments, replyMeta) — restored after, not before.
    document.getElementById('c-bcc').value = p.bcc || '';
    if (p.cc || p.bcc) document.querySelectorAll('.cc-row').forEach((r) => (r.hidden = false));
    document.getElementById('c-priority').value = p.priority || 'normal';
    document.getElementById('c-receipt').checked = !!p.readReceipt;
    attachments = (p.attachments || []).map((a) => ({ ...a }));
    restoreInlineImages();
    renderAttachments();
    replyMeta = (p.inReplyTo || p.references || p.original)
      ? { inReplyTo: p.inReplyTo, references: p.references, original: p.original }
      : null;
    prefilledRecipients = p.prefilledRecipients || [];
    dirty = true;
    // open() takes its pristine snapshot one tick from now; this has to land
    // AFTER that. The message has already been removed from the queue, so a
    // close that decided "nothing changed, nothing to save" would be silent data
    // loss — there is no copy of it anywhere else.
    setTimeout(() => { pristinePayload = null; dirty = true; }, 0);
  }

  function editDraft(msg) {
    open({
      to: msg.to.map((a) => a.address).join(', '),
      cc: msg.cc.map((a) => a.address).join(', '),
      subject: msg.subject === '(no subject)' ? '' : msg.subject,
      bodyHtml: msg.html || `<pre>${esc(msg.text || '')}</pre>`,
      context: 'new',
    });
    draftUid = msg.uid;
    restoreDraftParts(msg);
  }

  /** A blob as the base64 the send payload carries. */
  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1]);
      reader.onerror = () => reject(reader.error || new Error('Could not read that file'));
      reader.readAsDataURL(blob);
    });
  }

  /** Which cid: references the body actually uses right now. */
  function bodyCids() {
    return new Set([...document.getElementById('c-editor').querySelectorAll('img[src^="cid:"]')]
      .map((i) => i.getAttribute('src').slice(4)));
  }

  /**
   * Puts a draft's files back in the composer.
   *
   * open() clears `attachments`, and nothing used to put them back — so editing
   * a draft silently dropped every file on it and sent a message without them.
   * That was invisible until images could be pasted inline, at which point the
   * draft reopened showing broken images: the body still says
   * <img src="cid:…"> and there is nothing left for the cid to name.
   *
   * A part is inline if THE BODY REFERENCES ITS CID, not because a header said
   * so. Deciding it from `inlineUsed` alone would strand a part that is
   * structurally embedded but no longer referenced — getBody() prunes those, so
   * it would vanish from a draft that still listed it. Anything the body does
   * not reference becomes an ordinary attachment chip, which is recoverable;
   * the other way round loses a file.
   *
   * The original Content-ID is kept rather than a fresh one minted: the body's
   * existing references have to keep resolving, and rewriting them all would be
   * the same job done twice.
   */
  async function restoreDraftParts(msg) {
    const parts = (msg.attachments || []).filter((a) => a && a.index != null);
    if (!parts.length) return;
    const folder = msg.__folder || state.currentFolder;
    const uid = msg.uid;
    const referenced = bodyCids();
    const wasDraft = draftUid;
    try {
      await Promise.all(parts.map(async (a) => {
        const r = await fetch(`/api/message/${encodeURIComponent(folder)}/${encodeURIComponent(uid)}/attachment/${a.index}`);
        if (!r.ok) throw new Error(`part ${a.index}: HTTP ${r.status}`);
        const blob = await r.blob();
        const inline = !!(a.cid && referenced.has(a.cid));
        attachments.push({
          filename: a.filename || `attachment-${a.index}`,
          contentType: a.contentType || blob.type,
          contentBase64: await blobToBase64(blob),
          ...(inline ? { cid: a.cid, inline: true } : {}),
        });
      }));
    } catch (e) {
      // Better a visible warning than a message quietly sent without the file
      // somebody attached to it yesterday.
      toast(I18n.t('Could not load this draft\'s attachments') + ': ' + e.message, 6000);
    }
    // The composer may have moved on — a slow fetch must not push files into
    // whatever is being written now.
    if (draftUid !== wasDraft) return;
    restoreInlineImages();
    renderAttachments();
    // Restoring is not editing. Without this the freshly opened draft counts as
    // changed and the next autosave writes a second copy of it.
    dirty = false;
    pristinePayload = JSON.stringify(payload());
  }

  /**
   * The inverse of getBody()'s cid: swap, for a message coming back INTO the
   * editor — a cancelled undo-send or a rescheduled one.
   *
   * What was stored is `<img src="cid:x">`, which is right for the wire and
   * renders as a broken image in a contenteditable: nothing resolves a
   * Content-ID against an attachment list except a mail client displaying the
   * assembled message. The bytes are still in `attachments`, so they go back
   * to being data: URLs for as long as the message is being edited.
   */
  function restoreInlineImages() {
    const byCid = new Map(attachments.filter((a) => a.cid).map((a) => [a.cid, a]));
    if (!byCid.size) return;
    for (const img of document.getElementById('c-editor').querySelectorAll('img[src^="cid:"]')) {
      const cid = img.getAttribute('src').slice(4);
      const a = byCid.get(cid);
      if (!a || !a.contentBase64) continue; // not ours to restore — leave it exactly as it is
      img.src = `data:${a.contentType || 'application/octet-stream'};base64,${a.contentBase64}`;
      img.setAttribute('data-hmelj-cid', cid);
      a.inline = true;
    }
  }

  function addBlob(blob, filename, contentType) {
    const reader = new FileReader();
    reader.onload = () => {
      attachments.push({ filename, contentType: contentType || blob.type, contentBase64: reader.result.split(',')[1] });
      renderAttachments();
      dirty = true;
    };
    reader.readAsDataURL(blob);
  }

  /** A name for something the clipboard handed over without one — a screenshot
   *  is usually just "image/png" and no filename at all. Dated rather than
   *  numbered, so several in one message stay distinguishable after they land
   *  in someone's downloads folder. */
  function nameForBlob(blob, i) {
    const ext = ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg' })[blob.type]
      || (blob.type.split('/')[1] || 'bin').replace(/[^a-z0-9]/gi, '').slice(0, 8) || 'bin';
    const d = new Date();
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
      + `-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}`;
    return `image-${stamp}${i ? '-' + (i + 1) : ''}.${ext}`;
  }

  /**
   * An image dropped or pasted into the rich-text body, shown where the caret
   * is and sent as a real inline attachment.
   *
   * The <img> carries a data: URL while you are writing, because that is the
   * only thing the editor can actually render, and `data-hmelj-cid` naming the
   * Content-ID it will be sent under. getBody() swaps the two on the way out.
   * A data: URL must NOT be what goes on the wire — Gmail, Outlook and most
   * webmail strip them, so the recipient would see a broken image where you
   * saw a picture.
   */
  function insertInlineImage(blob, filename) {
    const reader = new FileReader();
    reader.onload = () => {
      const cid = `${crypto.randomUUID()}@hmelj`;
      attachments.push({ filename, contentType: blob.type, contentBase64: String(reader.result).split(',')[1], cid, inline: true });
      const img = document.createElement('img');
      img.src = reader.result;
      img.setAttribute('data-hmelj-cid', cid);
      img.alt = filename;
      // Big screenshots otherwise arrive at their full pixel width and force
      // the reader to scroll sideways through them.
      img.style.maxWidth = '100%';
      insertNodeAtCaret(img);
      renderAttachments();
      dirty = true;
    };
    reader.readAsDataURL(blob);
  }

  /** Puts a node where the caret is, if the caret is in the editor — and at the
   *  end of it otherwise (dropped onto the window without ever clicking in). */
  function insertNodeAtCaret(node) {
    const ed = document.getElementById('c-editor');
    const sel = window.getSelection();
    const range = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
    if (!range || !ed.contains(range.commonAncestorContainer)) {
      ed.appendChild(node);
    } else {
      range.deleteContents();
      range.insertNode(node);
      range.setStartAfter(node);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
    }
    ed.focus();
  }

  /**
   * Files arriving from a paste or a drop.
   *
   * An image goes INTO the body when there is a body to put it in — that is
   * what pasting a screenshot means in every other mail client. In plain-text
   * mode there is no such thing as an inline image, so it becomes an ordinary
   * attachment instead of being silently dropped.
   */
  function acceptFiles(files, { inline = false } = {}) {
    const list = [...files].filter(Boolean);
    if (!list.length) return false;
    list.forEach((f, i) => {
      const isImage = (f.type || '').startsWith('image/');
      const name = f.name || nameForBlob(f, i);
      if (inline && isImage && !isPlain()) insertInlineImage(f, name);
      else addBlob(f, name, f.type);
    });
    return true;
  }

  function renderAttachments() {
    const box = document.getElementById('c-attach-list');
    // Inline images are deliberately not chips: they are already visible in
    // the message, and a chip whose ✕ leaves a broken <img> behind in the body
    // would be a worse way to remove one than selecting it and pressing Delete
    // — which getBody() already cleans up after. The index carried on the
    // button is the index into `attachments`, not into the rendered list, so
    // removing a file never removes the wrong one.
    box.innerHTML = attachments.map((a, i) => (a.inline ? ''
      : `<span class="attach-chip">📎 ${esc(a.filename)} <button data-i="${i}" title="Remove">✕</button></span>`)).join('');
    box.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
      attachments.splice(+b.dataset.i, 1); renderAttachments();
    }));
  }

  /* ---------- contact suggestions (To/Cc/Bcc) ----------
   * A hand-built dropdown, not a native <input list> datalist popup (the
   * previous approach) — Android WebView's native datalist popup positions
   * itself against the pre-keyboard layout, not the actual keyboard-shrunk
   * visible viewport, so it rendered off-screen below the keyboard once
   * there were suggestions to show at all (the reported follow-up bug).
   * A plain fixed-position DOM element, positioned from the input's own
   * getBoundingClientRect() (which DOES correctly track the real,
   * keyboard-adjusted viewport), sidesteps that native-widget bug entirely. */
  let contactSuggestBox = null;
  let contactSuggestInput = null;   // which To/Cc/Bcc field the open box belongs to
  let contactSuggestOptions = [];   // [{label, value, contact}] currently listed
  let contactSuggestIndex = 0;      // the highlighted row — what Enter/Tab picks
  // Which row (if any) has been armed for deletion by a first Delete press. Two
  // presses, never one: this removes a saved contact, and one stray keystroke in
  // a text field must not be able to do that silently. Reset by literally
  // anything else — moving the highlight, typing, closing the box.
  let contactSuggestArmed = -1;
  function closeContactSuggest() {
    contactSuggestBox?.remove();
    contactSuggestBox = null;
    contactSuggestInput = null;
    contactSuggestOptions = [];
    contactSuggestIndex = 0;
    contactSuggestArmed = -1;
  }
  function positionContactSuggest(inputEl, box) {
    const r = inputEl.getBoundingClientRect();
    box.style.width = Math.max(r.width, 220) + 'px';
    box.style.left = Math.max(8, Math.min(r.left, innerWidth - box.offsetWidth - 8)) + 'px';
    // Prefer below the input; flip above only if there's genuinely more
    // room there — covers the keyboard having shrunk the visible viewport
    // enough that "below" is now mostly/entirely covered.
    const spaceBelow = innerHeight - r.bottom;
    const spaceAbove = r.top;
    box.style.top = (spaceBelow >= Math.min(box.offsetHeight, spaceAbove) + 8 || spaceBelow >= spaceAbove)
      ? (r.bottom + 4) + 'px'
      : (r.top - box.offsetHeight - 4) + 'px';
  }
  /** Shows (or hides, if `options` is empty) the suggestion dropdown for
   * `inputEl` — `options`: [{ label, value, contact }], `value` already includes
   * whatever was typed before the segment currently being typed (see
   * updateContactSuggestions below), so picking one replaces the whole field
   * value safely without losing an earlier address. */
  function showContactSuggest(inputEl, options) {
    closeContactSuggest();
    if (!options.length) return;
    const box = document.createElement('div');
    box.className = 'contact-suggest';
    box.innerHTML = options.map((o, i) => `<button type="button" tabindex="-1" data-i="${i}"></button>`).join('');
    document.body.appendChild(box);
    contactSuggestBox = box;
    contactSuggestInput = inputEl;
    contactSuggestOptions = options;
    paintContactSuggestRows();
    positionContactSuggest(inputEl, box);
    box.querySelectorAll('button').forEach((b) => {
      b.addEventListener('mousedown', (e) => {
        // mousedown, not click, with preventDefault: stops the default
        // focus-shift/blur that a mousedown on a non-input element normally
        // causes, so the To/Cc/Bcc field never actually loses focus over
        // this tap — the blur handler below closes the box for every OTHER
        // way of leaving the field, but must not race against selecting a
        // suggestion here.
        e.preventDefault();
        applyContactSuggestion(+b.dataset.i);
      });
      // Right-click on desktop AND long-press on mobile: WebViews dispatch
      // `contextmenu` for a long press, and unlike bindLongPress (which is
      // {passive:true} and so cannot preventDefault) this can suppress the
      // native text-selection popup that would otherwise fight the menu.
      b.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        showContactRowMenu(+b.dataset.i, e.clientX, e.clientY);
      });
    });
    // The first match starts highlighted, so Tab/Enter always has something
    // to commit without arrowing down first — the common case is that the
    // top match IS the one being typed towards.
    setContactSuggestIndex(0);
  }
  /** Writes each row's label, which is the highlight state plus — for a row
   *  armed by a first Delete press — the confirm prompt in place of it. */
  function paintContactSuggestRows() {
    if (!contactSuggestBox) return;
    contactSuggestBox.querySelectorAll('button').forEach((b, i) => {
      const armed = i === contactSuggestArmed;
      b.classList.toggle('active', i === contactSuggestIndex);
      b.classList.toggle('arm-delete', armed);
      const o = contactSuggestOptions[i];
      b.innerHTML = armed
        ? `🗑 ${esc(I18n.t('Remove from contacts?'))} <span class="cs-hint">${esc(I18n.t('press Del again'))}</span>`
        : esc(o.label) + (o.own ? ` <span class="cs-own">${esc(I18n.t('you'))}</span>` : '');
    });
  }
  /** Moves the highlight, keeping it in view inside the (scrollable) box. */
  function setContactSuggestIndex(i) {
    if (!contactSuggestBox) return;
    const n = contactSuggestOptions.length;
    contactSuggestIndex = ((i % n) + n) % n; // wraps both ways
    contactSuggestArmed = -1; // moving off a row abandons its pending delete
    paintContactSuggestRows();
    contactSuggestBox.querySelectorAll('button')[contactSuggestIndex]
      ?.scrollIntoView({ block: 'nearest' });
  }
  /** Commits the highlighted suggestion into its field and sets up for the
   * next recipient: the address is followed by ", " and focus stays put, so
   * typing simply continues into a fresh (empty) segment. The trailing
   * separator also means updateContactSuggestions sees nothing typed yet and
   * closes the box on its own — no explicit close needed here. */
  function applyContactSuggestion(i) {
    const opt = contactSuggestOptions[i];
    const inputEl = contactSuggestInput;
    if (!opt || !inputEl) return;
    inputEl.value = opt.value + ', ';
    inputEl.dispatchEvent(new Event('input', { bubbles: true })); // keeps dirty/suggestions in sync, same as a real keystroke
    inputEl.focus();
    inputEl.setSelectionRange(inputEl.value.length, inputEl.value.length);
  }

  /* ---------- removing a contact from the dropdown ----------
   * The address book fills up on its own now (server/contacts.js adds everyone
   * you write to), so the place it needs pruning is the place you notice the
   * dead address: the autocomplete itself, mid-compose. Two gestures, both
   * deliberately different in how much they ask first:
   *   - Delete arms the row, Delete again removes it. A keystroke in a text
   *     field must not be able to delete stored data on the first press.
   *   - Right-click / long-press opens a menu whose only item IS "remove", so
   *     choosing it is already the confirmation.
   */
  async function removeContact(i) {
    const opt = contactSuggestOptions[i];
    const inputEl = contactSuggestInput;
    if (!opt?.contact?.id) return;
    const { id, name, email } = opt.contact;
    // Belt and braces alongside the two gesture guards: this is the only
    // function that issues the DELETE, and for a synced row that DELETE reaches
    // somebody else's server.
    if (opt.contact.synced) {
      toast(I18n.t('That contact is synced from another server — remove it in Settings › Contacts.'), 5000);
      return;
    }
    try { state.contacts = (await API.deleteContact(id)).contacts; }
    catch (e) { return toast(I18n.t('Could not remove contact') + ': ' + e.message, 5000); }
    toast(`${I18n.t('Removed from contacts')}: ${name || email}`, 4000);
    // Repaint from what's left rather than closing: the user is mid-typing and
    // the remaining matches are still what they were looking for.
    if (inputEl && document.contains(inputEl)) updateContactSuggestions(inputEl);
    else closeContactSuggest();
  }

  function showContactRowMenu(i, x, y) {
    const opt = contactSuggestOptions[i];
    if (!opt?.contact?.id) return;
    const who = opt.contact.name || opt.contact.email;
    // A synced contact gets no remove item at all. The gesture is the same one
    // that prunes a dead local address, but the consequence is not: it would
    // delete the card from the server it came from. Say where it lives instead,
    // so the menu is not silently dead.
    if (opt.contact.synced) {
      openCtxMenu([{
        label: `☁ ${esc(I18n.t('Synced from'))} ${esc(opt.contact.sourceLabel || I18n.t('another server'))} — ${esc(I18n.t('remove it in Settings'))}`,
        disabled: true,
      }], x, y);
      return;
    }
    // openCtxMenu injects its labels as HTML (it runs them through I18n.t), and
    // a contact's name is somebody else's text — escape here, not there.
    openCtxMenu([{
      label: `🗑 ${esc(I18n.t('Remove from contacts'))} — ${esc(who)}`,
      danger: true,
      onClick: () => removeContact(i),
    }], x, y);
  }

  /** Keyboard control of the dropdown, bound per To/Cc/Bcc field. Every key
   * here is handled ONLY while the box is actually open for that field, so
   * with no suggestions showing, Tab/Enter/Escape all keep their normal
   * meaning (Tab moves to Subject, Escape reaches compose's own close). */
  function onContactSuggestKeydown(e, inputEl) {
    if (!contactSuggestBox || contactSuggestInput !== inputEl) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setContactSuggestIndex(contactSuggestIndex + (e.key === 'ArrowDown' ? 1 : -1));
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      // Tab completes rather than leaving the field — the user asked for the
      // highlighted contact, not the next form control. Shift+Tab is left
      // alone so going back is never hijacked into a completion.
      if (e.key === 'Tab' && e.shiftKey) return;
      e.preventDefault();
      applyContactSuggestion(contactSuggestIndex);
    } else if (e.key === 'Delete') {
      // Your own addresses aren't contacts and there is nothing to remove, so
      // Delete keeps its ordinary meaning on those rows rather than arming a
      // confirm that could never be honoured.
      //
      // A SYNCED contact is skipped for a much stronger reason: removing one
      // deletes the card from the server it is synced with — a shared Exchange
      // or CardDAV address book, possibly a colleague's. A keystroke in a text
      // field must never be able to do that, whatever it is confirmed with. It
      // is removable from Settings › Contacts, where the row says which server
      // it lives on.
      const del = contactSuggestOptions[contactSuggestIndex]?.contact;
      if (!del || del.synced) return;
      // First press arms the highlighted row and shows the confirm in place of
      // it; second press removes the contact. The keystroke is swallowed both
      // times — with a suggestion list open and a row highlighted, Delete means
      // "this one", not "eat the character in front of the caret".
      e.preventDefault();
      if (contactSuggestArmed === contactSuggestIndex) removeContact(contactSuggestIndex);
      else { contactSuggestArmed = contactSuggestIndex; paintContactSuggestRows(); }
      return;
    } else if (e.key === 'Escape') {
      // Dismisses just the dropdown. stopPropagation because compose's own
      // document-level Escape handler (see init) would otherwise take this
      // same keypress as "close the compose window".
      e.preventDefault();
      e.stopPropagation();
      closeContactSuggest();
    }
    // Anything else abandons a pending delete — an armed row must never survive
    // the user having moved on to doing something else.
    if (contactSuggestArmed !== -1 && e.key !== 'Delete') {
      contactSuggestArmed = -1;
      paintContactSuggestRows();
    }
  }
  /** Matches for whatever's currently being typed in `inputEl` — a
   * To/Cc/Bcc field can hold several addresses, so only the text after the
   * last separator (the one actually being typed right now) drives
   * suggestions, not the whole field. Both `,` and `;` count as separators:
   * the send path accepts either (nodemailer's parser handles both, as do
   * the EWS/Graph paths), so anyone typing Outlook-style `;` lists gets
   * working autocomplete instead of the whole field being treated as one
   * half-typed address. No suggestions at all when that segment is empty —
   * an untouched field, or one that just had a separator typed — which is
   * what keeps focusing an empty field from popping up every contact. */
  function updateContactSuggestions(inputEl) {
    const value = inputEl.value;
    const splitAt = Math.max(value.lastIndexOf(','), value.lastIndexOf(';')) + 1;
    const prefix = value.slice(0, splitAt);
    const typed = value.slice(splitAt).trim().toLowerCase();
    if (!typed) { closeContactSuggest(); return; }
    const hit = (name, email) =>
      (name && name.toLowerCase().includes(typed)) || (email && email.toLowerCase().includes(typed));
    const own = ownAddresses().filter((o) => hit(o.name, o.email));
    const ownEmails = new Set(own.map((o) => o.email.toLowerCase()));
    const matches = (state.contacts || [])
      // An address of yours that also ended up in Contacts (an import, usually)
      // is listed once, as yours — the row that knows it's you is the more
      // useful of the two.
      .filter((c) => hit(c.name, c.email) && !ownEmails.has(String(c.email || '').toLowerCase()))
      .slice(0, 20);
    const row = (name, email, extra) => {
      const full = name ? `${name} <${email}>` : email;
      return { label: full, value: prefix ? `${prefix} ${full}` : full, ...extra };
    };
    const options = [
      // Yours first: a small, fixed, high-signal set — CC'ing yourself is
      // common enough that it shouldn't be at the bottom of twenty contacts.
      ...own.map((o) => row(o.name, o.email, { own: true })),
      // `contact` rides along so a row can be deleted as well as picked (see
      // removeContact) — the label alone can't be mapped back to a stored row.
      ...matches.map((c) => row(c.name, c.email, { contact: c })),
    ];
    showContactSuggest(inputEl, options);
  }

  /** Your own addresses — every identity, then any mail account whose address no
   *  identity already covers. Offered in the recipient autocomplete but never
   *  written into Contacts: they are not people you know, they are you, and an
   *  address book you have to keep deleting yourself out of is worse than one
   *  that simply knows. Read live from `state` rather than cached, so adding an
   *  account or identity shows up in an already-open composer. */
  function ownAddresses() {
    const seen = new Set();
    const out = [];
    const add = (name, email) => {
      const addr = String(email || '').trim();
      const key = addr.toLowerCase();
      if (!addr.includes('@') || seen.has(key)) return;
      seen.add(key);
      out.push({ name: String(name || '').trim(), email: addr });
    };
    for (const i of identities) add(i.name, i.email);
    for (const a of (state.accounts || [])) add(a.label, a.email);
    return out;
  }

  function payload() {
    const { html, text } = getBody();
    return {
      identityId: document.getElementById('c-identity').value,
      to: document.getElementById('c-to').value.trim(),
      cc: document.getElementById('c-cc').value.trim() || undefined,
      bcc: document.getElementById('c-bcc').value.trim() || undefined,
      subject: document.getElementById('c-subject').value,
      html: isPlain() ? undefined : html,
      text,
      priority: document.getElementById('c-priority').value,
      readReceipt: document.getElementById('c-receipt').checked,
      // Only ever set on a reply — see the declaration. Rides along in the
      // stored payload too, so a scheduled message reopened months later still
      // knows which of its recipients the user actually chose.
      prefilledRecipients: prefilledRecipients.length ? prefilledRecipients : undefined,
      attachments,
      ...(replyMeta || {}),
    };
  }

  /** Returns whether the draft ended up saved (true also for "nothing to
   * save" — both count as "safe to close without losing anything" for
   * requestClose below). */
  async function saveDraftNow(silent = false) {
    if (!dirty && silent) return true;
    // A stray `input` event (seen on mobile — a contenteditable gaining
    // focus, autocorrect, etc.) can flip `dirty` true without the user
    // actually having changed anything. Comparing against the pristine
    // snapshot — the exact payload as of the last successful save, or as of
    // open() if there hasn't been one yet (see the assignment below) —
    // catches that case too, so a genuinely still-empty/untouched compose,
    // reply, or forward never gets silently saved as a draft — only an
    // explicit "Save draft" click (silent=false) always saves regardless.
    const p = payload();
    const snapshot = JSON.stringify(p);
    if (silent && snapshot === pristinePayload) return true;
    // Tracked so requestClose()/discardDraft() can wait for an already-in-
    // flight autosave to actually land before deciding what "close" means —
    // without this, closing (and choosing Discard) while a save was mid-
    // request saw draftUid still null, discarded nothing, and then the save
    // resolved a moment later and created the draft anyway, after the
    // window had already closed (the reported bug's second half).
    const task = (async () => {
      try {
        const acctId = currentIdentity().accountId || state.accounts[0]?.id;
        const r = await API.saveDraft({ ...p, previousUid: draftUid }, acctId);
        draftUid = r.uid;
        dirty = false;
        // Snapshot captured BEFORE the request went out, not recomputed now —
        // this is the exact content the server actually has, regardless of
        // anything typed while the save was in flight.
        pristinePayload = snapshot;
        // Offline the save is queued, not stored on the server (outbox.js) —
        // the draft is safe on this device and goes up on reconnect, and the
        // status line says which of the two happened rather than claiming the
        // stronger one.
        document.getElementById('draft-status').textContent = (r?.queued
          ? I18n.t('Draft saved on this device ')
          : 'Draft saved ') + new Date().toLocaleTimeString();
        return true;
      } catch (e) {
        if (!silent) toast('Draft save failed: ' + e.message);
        return false;
      }
    })();
    inFlightSave = task;
    const result = await task;
    if (inFlightSave === task) inFlightSave = null; // don't clear a NEWER save's own tracking if this one got superseded
    return result;
  }

  function startAutosave() {
    clearInterval(autosaveTimer);
    const secs = state.settings.autosaveDraftSeconds;
    if (secs > 0) autosaveTimer = setInterval(() => saveDraftNow(true), secs * 1000);
  }

  /** Actually closes the window — no prompts, no save/discard decision of
   * its own. Callers are expected to have already resolved whatever
   * happens to the draft (sent, saved, or explicitly discarded) before
   * calling this — see requestClose for the user-facing X/ESC path. */
  function close() {
    clearInterval(autosaveTimer);
    // The highlight ranges point at text nodes this window is done with.
    Proofread.close();
    el().hidden = true;
  }

  /** Whether compose is on screen as something the user is actually editing —
   * a draft merely minimized to the corner deliberately doesn't count, so an
   * Escape / back key meant for whatever is behind it doesn't get hijacked
   * into that draft's close prompt. */
  function isOpen() {
    return !el().hidden && !el().classList.contains('minimized');
  }

  /** Deletes the persisted draft this compose window is attached to, if
   * any (draftUid — set once either an explicit Save, an autosave tick, or
   * opening an existing draft has actually put one on the server). Goes
   * through the normal delete-message path (respects the account's
   * configured Delete behavior — Trash by default, so a discarded draft is
   * still recoverable) rather than a hard IMAP delete, unlike saveDraftNow's
   * own replace-in-place logic — that's replacing a stale autosave copy
   * with a newer one, an implementation detail the user never asked for or
   * sees; this is the user explicitly saying they don't want the draft. */
  async function discardDraft() {
    // If a silent autosave was already mid-request, wait for it to actually
    // land first — otherwise draftUid can still read null here even though
    // a save is about to create one a moment later, right after this
    // decides (wrongly) that there's nothing to delete.
    if (inFlightSave) await inFlightSave;
    if (draftUid) {
      const acctId = currentIdentity().accountId || state.accounts[0]?.id;
      const acct = state.accounts.find((a) => a.id === acctId);
      await API.deleteMsgs(acct?.draftsFolder || 'Drafts', [draftUid], acct?.id).catch(() => {});
      // If this draft is also what the reading pane is showing, the pane has to
      // let go of it — otherwise the message stays on screen after the row it
      // came from is gone, which is what a deleted draft used to look like.
      // Guarded on the uid: discarding a draft must not close some OTHER
      // message the reader opened alongside it.
      if (typeof closeMessage === 'function' && state.openUid === draftUid) closeMessage();
      loadMessages(); loadFolders();
    }
    close();
  }

  /** The X button / Escape key / hardware back key's shared entry point —
   * close() itself makes no decisions and never prompts, so every path that
   * can end the compose window without an explicit user action first (Send,
   * the dedicated Discard button) goes straight to close()/discardDraft();
   * only this one needs to figure out what "close" should even mean right now:
   *  - Nothing changed since the last time this draft was actually saved
   *    (or, if it was never saved at all, nothing was ever entered) ->
   *    just close, there's nothing to lose either way.
   *  - There ARE unsaved changes -> ask, with all three things the user could
   *    plausibly mean by closing now on offer at once (rather than the old
   *    two-button confirm, which could only offer one of them and made the
   *    other reachable only by cancelling and hunting for another button):
   *      Cancel       — go back to editing, nothing saved, nothing deleted
   *      Save draft   — keep it (never sends), then close
   *      Delete draft — throw it away, including whatever copy an explicit
   *                     save / an autosave tick already put on the server
   *                     (discardDraft() routes that through the account's
   *                     normal Delete behaviour, so it stays recoverable)
   *    The wording differs only in whether a saved copy already exists to
   *    fall back to; the three choices themselves are the same either way. */
  async function requestClose() {
    // Re-entrancy guard: the awaits below (an in-flight autosave, then the
    // prompt itself) leave a window where a second close attempt — easy with
    // a hardware back key, which is where this is now also reachable from —
    // would otherwise stack a second identical prompt on top of the first.
    if (closing) return;
    closing = true;
    try {
      // Same reasoning as discardDraft's own wait — draftUid/pristinePayload
      // must reflect an already-in-flight autosave's actual result before
      // deciding which wording below even applies, or which branch below can
      // react to a stale, about-to-change draftUid.
      if (inFlightSave) await inFlightSave;
      const unsaved = JSON.stringify(payload()) !== pristinePayload;
      if (!unsaved) { close(); return; }
      const choice = await Dialog.choose(
        draftUid
          ? I18n.t('Save your latest changes to this draft before closing? (It will not be sent.)')
          : I18n.t('This message has not been saved yet. Keep it as a draft? (It will not be sent.)'),
        {
          title: I18n.t('Unsaved changes'),
          buttons: [
            { label: I18n.t('Delete draft'), value: 'delete', danger: true },
            { label: I18n.t('Save draft'), value: 'save', primary: true },
          ],
        });
      // null (Cancel / Escape / backdrop tap / back key) — stay open exactly
      // as it was; the close attempt is simply abandoned, nothing lost.
      if (choice === 'save') {
        if (await saveDraftNow(false)) close();
        // else: save failed (saveDraftNow already toasted why) — stay open so the user can retry.
      } else if (choice === 'delete') {
        await discardDraft();
      }
    } finally {
      closing = false;
    }
  }

  function togglePlain(plain, convert = true) {
    const rich = document.getElementById('c-editor');
    const plainEl = document.getElementById('c-editor-plain');
    document.getElementById('editor-toolbar').querySelectorAll('button, #c-font').forEach((b) => (b.disabled = plain));
    if (convert) {
      if (plain) plainEl.value = htmlToText(rich.innerHTML);
      else rich.innerHTML = esc(plainEl.value).replace(/\n/g, '<br>');
      // The conversion just rebuilt the other editor's entire content from
      // scratch — whatever applySignatureForIdentity was tracking as "safe
      // to remove and replace" no longer corresponds to anything real
      // (insertedSignatureNode is now disconnected either way, but
      // insertedSignaturePlainText wouldn't otherwise know that). Forget
      // both rather than risk removing the wrong thing on the next identity
      // switch — worst case a later switch just appends without first
      // removing, same as if no signature had been auto-inserted yet.
      insertedSignatureNode = null;
      insertedSignaturePlainText = '';
      // Re-derived from whichever editor was just rebuilt: going rich -> plain the
      // quote is now a tail of text again (and may have moved, if the user edited
      // above it); going the other way there is no textarea tail to speak of.
      plainQuoteTail = plain ? quotedTailText(rich.innerHTML) : '';
    }
    rich.hidden = plain;
    plainEl.hidden = !plain;
    Proofread.setPlain(plain);
  }

  /** Puts the toolbar's font <select> and the editor's display font back to the
   *  configured default. Called from open() — see the note there for why leaving
   *  them alone between windows was wrong. Display only: what the RECIPIENT sees
   *  comes from freshBody()'s font-family, since #c-editor's own inline style is
   *  on the element itself and so never appears in the innerHTML payload() sends. */
  function applyDefaultFont() {
    const font = FONTS.includes(state.settings?.composeFont) ? state.settings.composeFont : 'system-ui';
    const fontSel = document.getElementById('c-font');
    if (fontSel) fontSel.value = font;
    document.getElementById('c-editor').style.fontFamily = FONT_STACK[font] || '';
  }

  /* ---------- send later ----------
   * At IIFE scope, not inside init(): the module's return statement exports
   * pickSendTime, so a definition nested in init() leaves it unreachable there —
   * which throws while the IIFE is still evaluating and leaves `Compose` itself
   * permanently in the temporal dead zone. */
  /** The next time the clock locally reads HH:MM — later today if it's still
   *  ahead, otherwise tomorrow. Same helper the folder-mute menu uses; kept
   *  local to compose rather than shared, since the two menus have no other
   *  overlap and one of them is in app.js. */
  function nextLocalAt(hh, mm, addDays = 0) {
    const t = new Date();
    t.setHours(hh, mm, 0, 0);
    if (addDays) t.setDate(t.getDate() + addDays);
    else if (t.getTime() <= Date.now()) t.setDate(t.getDate() + 1);
    return t.getTime();
  }

  /** The coming Monday at HH:MM (today, if it's Monday and still ahead). */
  /** The next `dow` (0=Sunday … 6=Saturday) at hh:mm, always in the future —
   *  today counts only if that time has not passed yet. nextMonday is this with
   *  dow=1 and is kept as its own name because that is what the send presets
   *  ask for. */
  function nextWeekday(dow, hh, mm) {
    const d = new Date();
    d.setHours(hh, mm, 0, 0);
    let add = (dow - d.getDay() + 7) % 7;
    if (add === 0 && d.getTime() <= Date.now()) add = 7;
    d.setDate(d.getDate() + add);
    return d.getTime();
  }

  function nextMonday(hh, mm) {
    const t = new Date();
    t.setHours(hh, mm, 0, 0);
    const days = (8 - t.getDay()) % 7; // 1 = Monday
    if (days || t.getTime() <= Date.now()) t.setDate(t.getDate() + (days || 7));
    return t.getTime();
  }

  /** Local time as the value a datetime-local input wants (no timezone, no
   *  seconds) — toISOString would silently shift it by the UTC offset. */
  function toLocalInputValue(ms) {
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  /**
   * The "when?" menu, as a promise of a timestamp (or null if dismissed).
   * Shared by compose's own Send ▾ and by rescheduling an already-queued message
   * from the Scheduled view — one list of presets, one picker, so the two can't
   * drift apart in what they offer or how they parse a date.
   *
   * Resolving null covers both "pressed Escape" and "closed the menu", which
   * from every caller's point of view are the same answer.
   *
   * `current` is the time already set, passed when rescheduling: it heads the
   * menu and, more importantly, seeds the date picker. Without it the picker
   * opened on tomorrow 08:00 — a suggestion, presented as if it were the
   * message's current setting, in the one place the user came to read that
   * setting off the screen.
   */
  /**
   * "Sent — Undo", for the seconds the server is holding the message back.
   *
   * The window is the server's, not this toast's: the message is on the
   * scheduled-send queue and goes out when its time comes whether or not this
   * tab is still open, so the toast only ever shows an offer that is really
   * available. It is shown a second SHORT of the real window, because a cancel
   * that arrives as the runner picks the message up is refused with a 409 —
   * better to withdraw the offer slightly early than to have it fail in the
   * user's hand.
   */
  async function offerUndoSend(rec, seconds) {
    const ms = Math.max(1000, ((Number(seconds) || 0) * 1000) - 1000);
    toast(I18n.t('Sending…'), ms, async () => {
      try {
        const { payload } = await API.cancelScheduled(rec.id);
        // Straight back into the composer with everything it had — the same
        // path a cancelled scheduled message takes (see app.js#cancelScheduled).
        reopen(payload);
        toast(I18n.t('Send undone — your message is back'));
      } catch (e) {
        // 409: the runner already had it. Nothing was lost and nothing can be
        // done, so say what happened rather than showing a failure.
        if (e.status === 409) toast(I18n.t('Too late — that message has already gone out'), 5000);
        else toast(I18n.t('Could not undo the send') + ': ' + e.message, 6000);
      }
    }, I18n.t('Undo'));
  }

  /**
   * `mode` picks which set of presets and which wording — 'send' (the default)
   * for Send later, 'snooze' for bringing a message back.
   *
   * One function for both on purpose: they are the same question asked about
   * different objects, and two copies would drift. Snoozing gets a "Later
   * today" that sending has no use for (a message you send in three hours was
   * scheduled; a message that comes back in three hours was snoozed), and its
   * wording never mentions the server needing to be running, because unlike a
   * send a late wake still does exactly the right thing when it happens.
   */
  /**
   * "You said it was attached." Asked before the message goes anywhere.
   *
   * Reads only what the user WROTE — getBody() minus the quoted block. A reply
   * to somebody who said "the invoice is attached" must not ask: that sentence
   * is not this person's, and the attachment was on the other message. Same for
   * the signature, which is inside .compose-body but is not something anyone
   * typed just now.
   *
   * Returns true to go ahead. Any failure inside is treated as "go ahead": a
   * broken guard must never be able to stop mail from being sent.
   */
  async function attachmentCheck(p) {
    try {
      if (state.settings.attachmentReminder === false) return true;
      const ed = document.getElementById('c-editor');
      let typed;
      if (isPlain()) {
        // Plain mode: the quoted original sits at the END of the textarea, so
        // what is theirs is everything before it. Same test the signature code
        // uses, rather than splitting on a blank line — which would have cut
        // the message off at its first paragraph break.
        const text = p.text || '';
        typed = plainQuoteTail && text.endsWith(plainQuoteTail) ? text.slice(0, -plainQuoteTail.length) : text;
      } else {
        const host = ed?.querySelector(':scope > .' + BODY_CLASS) || ed;
        const clone = host.cloneNode(true);
        for (const drop of clone.querySelectorAll('.' + QUOTE_CLASS + ', .' + SIGNATURE_WRAP)) drop.remove();
        typed = clone.textContent || '';
      }
      if (!ComposeGuards.missingAttachment({
        text: typed, attachmentCount: attachments.length, lang: Proofread.language?.() || 'auto',
      })) return true;
      return !!await Dialog.confirm(
        I18n.t('Your message mentions an attachment, but nothing is attached. Send it anyway?'),
        { title: I18n.t('No attachment'), okLabel: I18n.t('Send anyway') },
      );
    } catch (e) {
      console.warn('Attachment check failed:', e);
      return true;
    }
  }

  function pickSendTime(x, y, { current = null, mode = 'send' } = {}) {
    const snoozing = mode === 'snooze';
    return new Promise((resolve) => {
      let answered = false;
      const done = (v) => { if (!answered) { answered = true; resolve(v); } };
      const items = [];
      if (current) items.push({ label: `🕗 ${I18n.t(snoozing ? 'Comes back' : 'Due')}: ${fmtDate(current, { long: true })}`, disabled: true });
      const presets = snoozing
        ? [
          // Only offered while it is still meaningfully "later today" — at
          // 22:00 a preset three hours out is tomorrow, and would read as one
          // option quietly meaning something else.
          ...(new Date().getHours() < 19 ? [{ label: 'Later today', at: Date.now() + 3 * 3600e3 }] : []),
          { label: 'Tomorrow morning', at: nextLocalAt(8, 0, 1) },
          { label: 'This weekend', at: nextWeekday(6, 8, 0) },
          { label: 'Next week', at: nextMonday(8, 0) },
        ]
        : [
          { label: 'Tomorrow morning', at: nextLocalAt(8, 0, 1) },
          { label: 'Tomorrow afternoon', at: nextLocalAt(13, 0, 1) },
          { label: 'Monday morning', at: nextMonday(8, 0) },
        ];
      items.push(...presets.map(({ label, at }) => ({
        label: `${I18n.t(label)} — ${fmtDate(at, { long: true })}`,
        onClick: () => done(at),
      })));
      items.push({
        label: 'Pick date & time…',
        onClick: async () => {
          const suggested = toLocalInputValue(current || nextLocalAt(8, 0, 1));
          const value = await Dialog.form(
            I18n.t(snoozing ? 'Snooze until' : 'Send later'),
            `<label class="dialog-label">${I18n.t(snoozing ? 'Bring this message back at' : 'Send this message at')}</label>
             <input class="dialog-input" type="datetime-local" value="${escAttr(suggested)}">
             <div class="set-hint">${I18n.t(snoozing
               ? 'If your server is not running then, the message comes back as soon as it is.'
               : 'Your server has to be running then — if it is not, the message goes out as soon as it is back.')}</div>`,
            { okLabel: I18n.t(snoozing ? 'Snooze' : 'Schedule'), getValue: (r) => r.querySelector('.dialog-input').value },
          );
          if (!value) return done(null); // cancelled, or the picker left empty
          const at = new Date(value).getTime();
          if (!Number.isFinite(at)) { toast(I18n.t('That is not a valid date')); return done(null); }
          done(at);
        },
      });
      // Dismissing the menu without choosing has to resolve too, or an awaiting
      // caller hangs forever holding a disabled button.
      openCtxMenu(items, x, y, { onClose: () => done(null) });
    });
  }

  async function showSendLaterMenu(x, y) {
    const at = await pickSendTime(x, y);
    if (at) sendAt(at);
  }

  /**
   * Hands the message to the server's queue instead of sending it now. Shares
   * the whole send path — same payload, same validation, same draft cleanup —
   * so a scheduled message can't diverge from an immediate one in what actually
   * goes out. Only `sendAt` differs.
   */
  async function sendAt(at) {
    const p = payload();
    if (!p.to) return toast('Add at least one recipient');
    const btn = document.getElementById('btn-send-later');
    btn.disabled = true;
    try {
      await API.send({ ...p, previousUid: draftUid, sendAt: at },
        currentIdentity().accountId || state.accounts[0]?.id);
      dirty = false;
      close();
      toast(`${I18n.t('Will send')} ${fmtDate(at, { long: true })}`, 5000);
      loadFolders();
      refreshScheduled();
    } catch (e) {
      toast('Could not schedule: ' + e.message, 6000);
    } finally {
      btn.disabled = false;
    }
  }

  function init() {
    const fontSel = document.getElementById('c-font');
    fontSel.innerHTML = FONTS.map((f) => `<option value="${f}">${f === 'system-ui' ? esc(I18n.t('System default')) : f}</option>`).join('');
    fontSel.addEventListener('change', () => {
      // execCommand is what reaches the message itself (a <font face> around the
      // selection, or around whatever gets typed next when nothing is selected);
      // the style below is only so the editor looks like the result.
      document.execCommand('fontName', false, fontSel.value);
      document.getElementById('c-editor').style.fontFamily = FONT_STACK[fontSel.value] || '';
    });

    document.getElementById('editor-toolbar').querySelectorAll('button[data-cmd]').forEach((b) => {
      b.addEventListener('mousedown', (e) => e.preventDefault()); // keep selection
      b.addEventListener('click', async () => {
        const cmd = b.dataset.cmd;
        if (cmd === 'createLink') {
          // the dialog steals focus, so preserve the editor selection
          const sel = window.getSelection();
          const range = sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
          const url = await Dialog.prompt(I18n.t('Insert link'), { label: I18n.t('Link URL (https://…):'), placeholder: 'https://' });
          if (url && range) {
            sel.removeAllRanges();
            sel.addRange(range);
            document.execCommand('createLink', false, url);
          }
        } else {
          document.execCommand(cmd, false, null);
        }
      });
    });

    document.getElementById('c-plain').addEventListener('change', (e) => togglePlain(e.target.checked));
    document.getElementById('btn-cc-toggle').addEventListener('click', () =>
      document.querySelectorAll('.cc-row').forEach((r) => (r.hidden = !r.hidden)));

    ['c-to', 'c-cc', 'c-bcc', 'c-subject'].forEach((id) =>
      document.getElementById(id).addEventListener('input', () => (dirty = true)));
    // No suggestions at all until something's actually typed (see
    // updateContactSuggestions) — 'focus' re-syncs the dropdown to
    // whatever's already in the field (relevant when tabbing back into a
    // field that already has a partial address in it); 'input' keeps it
    // matching as the user types; 'blur' closes it for every way of leaving
    // the field OTHER than tapping a suggestion (that case is handled by
    // showContactSuggest's own mousedown/preventDefault, which stops the
    // blur from firing in the first place — this still has to run, or the
    // box would never close when the user taps away instead).
    ['c-to', 'c-cc', 'c-bcc'].forEach((id) => {
      const inputEl = document.getElementById(id);
      inputEl.addEventListener('focus', () => updateContactSuggestions(inputEl));
      inputEl.addEventListener('input', () => updateContactSuggestions(inputEl));
      inputEl.addEventListener('blur', () => closeContactSuggest());
      // Arrow keys / Enter / Tab / Escape while the dropdown is open — see
      // onContactSuggestKeydown, which no-ops entirely when it isn't.
      inputEl.addEventListener('keydown', (e) => onContactSuggestKeydown(e, inputEl));
    });
    // The keyboard opening/closing (or any other viewport change) can leave
    // an already-open suggestion box positioned against a viewport that no
    // longer exists — simplest correct fix is to just close it; the next
    // keystroke reopens it freshly positioned.
    addEventListener('resize', () => closeContactSuggest());
    // Spell checking attaches its own debounced `input` listener alongside this
    // one and draws underlines with the CSS Custom Highlight API — it never
    // touches the editor's DOM, so getBody()/payload() stay exactly as they were
    // (see the header of public/js/proofread.js for why that matters here).
    Proofread.init({ onEdit: () => (dirty = true) });
    document.getElementById('c-editor').addEventListener('input', () => (dirty = true));
    document.getElementById('c-editor-plain').addEventListener('input', () => (dirty = true));
    document.getElementById('c-subject').addEventListener('input', (e) =>
      (document.getElementById('compose-title').textContent = e.target.value || 'New message'));

    document.getElementById('btn-attach').addEventListener('click', () => document.getElementById('c-file').click());
    document.getElementById('c-file').addEventListener('change', (e) => {
      for (const f of e.target.files) addBlob(f, f.name, f.type);
      e.target.value = '';
      dirty = true;
    });

    document.getElementById('btn-send').addEventListener('click', async () => {
      const p = payload();
      if (!p.to) return toast('Add at least one recipient');
      if (!await attachmentCheck(p)) return;
      const btn = document.getElementById('btn-send');
      // Only guards against a double-click firing two sends in the brief
      // window before the server acks — /api/send now responds as soon as
      // it's validated the request, not after the actual send completes,
      // so there's no multi-second wait to show a spinner for anymore.
      btn.disabled = true;
      try {
        // previousUid: the server replaces this compose window's own
        // autosaved draft copy in place — on success, once the background
        // send actually finishes; on failure, with the failed content
        // itself, so it's recoverable exactly like a normal autosave would
        // be. Either way, no separate client-side draft cleanup needed
        // anymore — dropped the old post-send deleteMsgs call here.
        const r = await API.send({ ...p, previousUid: draftUid }, currentIdentity().accountId || state.accounts[0]?.id);
        dirty = false;
        close();
        // With an undo window configured the server has QUEUED the message
        // rather than sent it (server/index.js's undo branch), and hands back
        // the queue record. The offer runs for exactly as long as the server
        // said it would hold the message, so the toast can never outlast the
        // window and promise a recall that will be refused.
        if (r?.undo?.id) offerUndoSend(r.undo, r.undoSeconds);
        // Queued rather than sent: there was no server to hand it to, so it is
        // sitting in this device's outbox (api.js's _write / outbox.js). Saying
        // "Sending…" here would be a promise nothing is currently keeping — and
        // the Outbox row in the sidebar is where it can be seen, edited or
        // discarded until it goes.
        else if (r?.queued) toast(I18n.t('No connection — queued in the Outbox and sent when it’s back'), 6000);
        else toast(I18n.t('Sending…'));
        loadFolders();
      } catch (e) {
        // Only reachable for the fast synchronous validation now (bad
        // recipient, no account configured) — an actual send failure
        // happens later, in the background, and surfaces as a push
        // notification + a recovered draft instead of a toast here.
        toast('Could not send: ' + e.message, 6000);
      } finally {
        btn.disabled = false;
      }
    });

    /* ---------- paste and drag-and-drop ----------
     * Neither existed: pasting a screenshot did nothing, and dropping a file
     * onto the composer let the BROWSER handle it — which means navigating the
     * page away to display that file, losing whatever was being written.
     * Registered on the whole compose window rather than the editor, because
     * dropping onto the subject line or the attachment strip obviously means
     * the same thing. */
    const win = document.getElementById('compose-window');
    const editor = document.getElementById('c-editor');

    // Paste is bound to the editor and the plain textarea: pasting into the To
    // field must stay ordinary text.
    for (const el of [editor, document.getElementById('c-editor-plain')]) {
      el.addEventListener('paste', (e) => {
        const dt = e.clipboardData;
        if (!dt) return;
        // Files first, but only when there is no text alongside them. Copying
        // a cell from a spreadsheet, or an image from a web page, puts BOTH an
        // image and the real content on the clipboard — and taking the image
        // there would paste a picture of a table instead of the table.
        const files = [...(dt.files || [])];
        const hasText = [...(dt.types || [])].some((t) => t === 'text/plain' || t === 'text/html');
        if (files.length && !hasText) {
          e.preventDefault();
          acceptFiles(files, { inline: true });
        }
      });
    }

    // dragover must be cancelled or the drop never fires — that is the whole
    // reason dropping a file "did nothing" except navigate away.
    let dragDepth = 0;
    win.addEventListener('dragover', (e) => {
      if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });
    // enter/leave counted rather than toggled: moving over a child element
    // fires leave on the parent, so a plain toggle flickers the highlight off
    // while the pointer is still very much inside the window.
    win.addEventListener('dragenter', (e) => {
      if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
      dragDepth++;
      win.classList.add('drag-over');
    });
    win.addEventListener('dragleave', () => {
      if (dragDepth > 0) dragDepth--;
      if (!dragDepth) win.classList.remove('drag-over');
    });
    win.addEventListener('drop', (e) => {
      const files = [...(e.dataTransfer?.files || [])];
      dragDepth = 0;
      win.classList.remove('drag-over');
      if (!files.length) return; // dragged text or a link — let the browser do its normal thing
      e.preventDefault();
      // Inline only when dropped INTO the message body; onto the header or the
      // attachment strip means "attach this".
      acceptFiles(files, { inline: editor.contains(e.target) });
    });

    // mousedown+preventDefault, like the formatting buttons above: clicking a
    // toolbar button must not take the selection out of the editor first, or an
    // insert-at-the-caret lands nowhere.
    document.getElementById('c-template')?.addEventListener('mousedown', (e) => e.preventDefault());
    document.getElementById('c-template')?.addEventListener('click', (e) => {
      const r = e.currentTarget.getBoundingClientRect();
      showTemplateMenu(r.left, r.bottom);
    });

    document.getElementById('btn-send-later').addEventListener('click', (e) => {
      const p = payload();
      if (!p.to) return toast('Add at least one recipient');
      const r = e.currentTarget.getBoundingClientRect();
      showSendLaterMenu(r.left, r.top);
    });

    document.getElementById('btn-draft-save').addEventListener('click', () => { dirty = true; saveDraftNow(); });
    document.getElementById('btn-compose-min').addEventListener('click', () => el().classList.toggle('minimized'));
    document.getElementById('compose-titlebar').addEventListener('dblclick', () => el().classList.toggle('minimized'));
    // "Bigger, not full-space" on desktop, full page size on mobile — see
    // the .compose-window.large rules in app.css for the actual sizing;
    // this button just toggles the class.
    document.getElementById('btn-compose-enlarge').addEventListener('click', () => el().classList.toggle('large'));
    document.getElementById('btn-compose-close').addEventListener('click', requestClose);
    document.getElementById('btn-compose-discard').addEventListener('click', async () => {
      await discardDraft();
      toast('Draft discarded');
    });
    document.getElementById('c-identity').addEventListener('change', () => {
      // Whether there's any REAL content yet (recipients, subject, typed
      // body — anything beyond whatever open() auto-filled) has to be
      // judged from BEFORE the signature swap below, not after — the swap
      // itself always changes the payload (a different signature), which
      // would otherwise make this look like "real content was just added"
      // even when literally nothing but the From identity was touched.
      const wasPristine = JSON.stringify(payload()) === pristinePayload;
      // Swaps the signature for the newly-selected identity — see
      // applySignatureForIdentity's own doc comment for exactly what
      // "swap" means when the previous one has since been edited/removed.
      applySignatureForIdentity(currentIdentity(), composeContext);
      dirty = true;
      // Nothing but the auto-managed signature changed so far — advance the
      // pristine baseline to match it, so switching identities alone never
      // looks like a real edit worth autosaving or prompting to discard on
      // close (the reported bug: picking an identity with a signature was
      // silently creating a signature-only draft). If real content already
      // existed before this switch, leave the baseline alone — that's a
      // genuine, unrelated edit that still needs to be tracked as dirty.
      if (wasPristine) pristinePayload = JSON.stringify(payload());
    });
    // Only while compose is actually open and not just minimized in the
    // corner — otherwise Escape pressed for an unrelated reason (closing a
    // message view, a context menu) while a draft sits minimized would
    // unexpectedly trigger its close/discard prompt. Skipped while a
    // Dialog.* confirm/prompt is up — that dialog's own Escape handler
    // (see dialog.js) already owns this keypress; without this check both
    // would fire off the same bubbling keydown event.
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (!isOpen()) return;
      if (document.querySelector('.dialog-backdrop')) return;
      requestClose();
    });
  }

  return { init, open, reopen, reply, forward, editDraft, setIdentities, setTemplates, requestClose, isOpen, pickSendTime, fonts: () => [...FONTS] };
})();
