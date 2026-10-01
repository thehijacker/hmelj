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
  // The inline style a quote carries into the sent mail. ONE constant, used by
  // both the ❝ Quote button and quoteBlock()'s reply quoting, so a quote you
  // made and a quote Hmelj made are the same object in the recipient's client.
  // Inline because they have none of our CSS — a bare <blockquote> is styled by
  // whatever their client happens to think, which in Outlook is nothing at all.
  const QUOTE_STYLE = 'margin:0 0 0 8px;padding-left:10px;border-left:2px solid #8ab4f8;color:inherit';
  // Same reasoning for a code block. white-space:pre-wrap rather than plain pre:
  // a <pre> in a 560px composer that a phone opens at 360px would otherwise
  // scroll sideways forever on the one line somebody pasted from a terminal.
  const CODE_STYLE = 'margin:8px 0;padding:8px 10px;background:#f1f3f4;border-radius:6px;'
    + "font-family:'Courier New',Courier,monospace;font-size:13px;white-space:pre-wrap;word-break:break-word";

  // Gmail's four, and its names for them. execCommand('fontSize') only speaks
  // 1–7, so these are the four of those seven that are far enough apart to be
  // worth offering. `px` is for the picker's own preview only — what reaches the
  // message is <font size="N">.
  const SIZES = [
    { size: 2, label: 'Small', px: 13 },
    { size: 3, label: 'Normal', px: 16 },
    { size: 5, label: 'Large', px: 24 },
    { size: 6, label: 'Huge', px: 32 },
  ];

  // Two rows of ten, dark to light, plus the greys. Kept small on purpose: a
  // full colour wheel in a mail composer is a way to make text nobody can read,
  // and every one of these is legible on white.
  const TEXT_COLORS = [
    '#000000', '#434343', '#666666', '#999999', '#b7b7b7', '#cccccc', '#d9d9d9', '#efefef', '#f3f3f3', '#ffffff',
    '#980000', '#ff0000', '#ff9900', '#ffff00', '#00ff00', '#00ffff', '#4a86e8', '#0000ff', '#9900ff', '#ff00ff',
    '#e6b8af', '#f4cccc', '#fce5cd', '#fff2cc', '#d9ead3', '#d0e0e3', '#c9daf8', '#cfe2f3', '#d9d2e9', '#ead1dc',
    '#a61c00', '#cc0000', '#e69138', '#f1c232', '#6aa84f', '#45818e', '#3c78d8', '#3d85c6', '#674ea7', '#a64d79',
  ];
  // Highlights are the pale half only — a dark highlight under dark text is
  // unreadable, and the picker should not offer a way to get there.
  const HILITE_COLORS = [
    '#ffffff', '#f3f3f3', '#efefef', '#d9d9d9', '#cccccc',
    '#fce5cd', '#fff2cc', '#ffff00', '#d9ead3', '#00ff00',
    '#d0e0e3', '#c9daf8', '#cfe2f3', '#00ffff', '#d9d2e9',
    '#ead1dc', '#f4cccc', '#e6b8af', '#ff9900', '#ffcccc',
  ];

  // A curated set, not a full Unicode table: a picker is for finding one
  // quickly, and 3,600 emoji sorted by codepoint is not that. Grouped the way
  // people look for them, common-first within each group.
  const EMOJI = [
    ['Smileys', '😀😃😄😁😆😅🤣😂🙂🙃😉😊😇🥰😍🤩😘😗😚😙🥲😋😛😜🤪😝🤗🤭🤔🤐😐😑😶😏😒🙄😬😮‍💨😌😔😪🤤😴😷🤒🤕🤢🤮🥵🥶😵🤯🤠🥳😎🤓🧐😕😟🙁😮😯😲😳🥺😦😧😨😰😥😢😭😱😖😣😞😓😩😫🥱😤😡🤬😈💀💩'],
    ['People', '👋🤚🖐✋🖖👌🤌🤏✌🤞🤟🤘🤙👈👉👆👇☝👍👎✊👊🤛🤜👏🙌👐🤲🤝🙏✍💅🤳💪🦾🦵🦶👂👃🧠🦷🦴👀👁👅👄💋👶🧒👦👧🧑👨👩🧓👴👵🙍🙎🙅🙆💁🙋🧏🙇🤦🤷👮🕵💂🥷👷🤴👸👳👲🧕🤵👰🤰🤱👼🎅🤶🦸🦹'],
    ['Nature', '🐶🐱🐭🐹🐰🦊🐻🐼🐨🐯🦁🐮🐷🐸🐵🙈🙉🙊🐒🐔🐧🐦🐤🦆🦅🦉🦇🐺🐗🐴🦄🐝🐛🦋🐌🐞🐜🦂🐢🐍🦎🐙🦑🦐🦀🐡🐠🐟🐬🐳🐋🦈🐊🐅🐆🦓🦍🐘🦏🐪🐫🦒🐃🐄🐎🐖🐏🐑🐐🦌🐕🐩🐈🐓🦃🕊🐇🐁🐀🌲🌳🌴🌵🌾🌿☘🍀🍁🍂🍃🌷🌹🌺🌸🌼🌻'],
    ['Food', '🍏🍎🍐🍊🍋🍌🍉🍇🍓🫐🍈🍒🍑🥭🍍🥥🥝🍅🍆🥑🥦🥬🥒🌶🌽🥕🧄🧅🥔🍠🥐🥯🍞🥖🥨🧀🥚🍳🧈🥞🧇🥓🥩🍗🍖🌭🍔🍟🍕🥪🥙🌮🌯🥗🥘🍝🍜🍲🍛🍣🍱🥟🦪🍤🍙🍚🍘🍥🥠🥮🍢🍡🍧🍨🍦🥧🧁🍰🎂🍮🍭🍬🍫🍿🍩🍪☕🍵🧃🥤🍶🍺🍻🥂🍷🥃🍸🍹🧉'],
    ['Travel', '🚗🚕🚙🚌🚎🏎🚓🚑🚒🚐🚚🚛🚜🛴🚲🛵🏍🚨🚔🚍🚘🚖🚡🚠🚟🚃🚋🚞🚝🚄🚅🚈🚂🚆🚇🚊🚉✈🛫🛬🛩💺🚀🛸🚁🛶⛵🚤🛥🛳⛴🚢⚓🚧⛽🚏🗺🗿🗽🗼🏰🏯🏟🎡🎢🎠⛲⛱🏖🏝🏜🌋⛰🏔🗻🏕⛺🏠🏡🏘🏚🏗🏭🏢🏬🏣🏤🏥🏦🏨🏪🏫🏩💒🏛⛪🕌🕍🛕🕋'],
    ['Activity', '⚽🏀🏈⚾🥎🎾🏐🏉🥏🎱🪀🏓🏸🏒🏑🥍🏏🥅⛳🪁🏹🎣🤿🥊🥋🎽🛹🛷⛸🥌🎿⛷🏂🪂🏋🤼🤸⛹🤺🤾🏌🏇🧘🏄🏊🤽🚣🧗🚵🚴🏆🥇🥈🥉🏅🎖🏵🎗🎫🎟🎪🤹🎭🩰🎨🎬🎤🎧🎼🎹🥁🎷🎺🎸🪕🎻🎲♟🎯🎳🎮🎰🧩'],
    ['Objects', '⌚📱💻⌨🖥🖨🖱🖲🕹🗜💽💾💿📀📼📷📸📹🎥📞☎📟📠📺📻🎙⏱⏲⏰🕰⌛⏳📡🔋🔌💡🔦🕯🧯🛢💸💵💴💶💷💰💳💎⚖🧰🔧🔨⚒🛠⛏🔩⚙🧱⛓🧲🔫💣🧨🪓🔪🗡⚔🛡🚬⚰⚱🏺🔮📿🧿💈⚗🔭🧬🔬🕳💊💉🩸🧷🧹🧺🧻🚽🚿🛁🛀🧼🪒🧽🧴🛎🔑🗝🚪🪑🛋🛏🛌🧸🖼🛍🛒🎁🎈🎏🎀🎊🎉🎎🏮🎐🧧✉📩📨📧💌📥📤📦🏷📪📫📬📭📮📯📜📃📄📑📊📈📉🗒🗓📆📅🗑📇🗃🗳🗄📋📁📂🗂🗞📰📓📔📒📕📗📘📙📚📖🔖🧷🔗📎🖇📐📏🧮📌📍✂🖊🖋✒🖌🖍📝✏🔍🔎🔏🔐🔒🔓'],
    ['Symbols', '❤🧡💛💚💙💜🖤🤍🤎💔❣💕💞💓💗💖💘💝💟☮✝☪🕉☸✡🔯🕎☯☦🛐⛎♈♉♊♋♌♍♎♏♐♑♒♓🆔⚛🉑☢☣📴📳🈶🈚🈸🈺🈷✴🆚💮🉐㊙㊗🈴🈵🈹🈲🅰🅱🆎🆑🅾🆘❌⭕🛑⛔📛🚫💯💢♨🚷🚯🚳🚱🔞📵🚭❗❕❓❔‼⁉🔅🔆〽⚠🚸🔱⚜🔰♻✅🈯💹❇✳❎🌐💠Ⓜ🌀💤🏧🚾♿🅿🈳🈂🛂🛃🛄🛅🚹🚺🚼🚻🚮🎦📶🈁🔣ℹ🔤🔡🔠🆖🆗🆙🆒🆕🆓0️⃣1️⃣2️⃣3️⃣4️⃣5️⃣6️⃣7️⃣8️⃣9️⃣🔟'],
  ];
  // Last-used-first, this device only. An emoji picker whose first row is the
  // ten you actually use is a different tool from one that is not.
  const EMOJI_RECENT_KEY = 'hmelj-emoji-recent';
  const EMOJI_RECENT_MAX = 24;
  /**
   * The three priorities, as the button shows them.
   *
   * `↑ ≡ ↓` is one family varying only in direction, which reads as a scale at
   * 20px in a way three different symbols would not. Normal is deliberately
   * NOT orange in a green/amber/red set: it is the default that almost every
   * message is sent at, and a default that colours itself is a default that
   * keeps asking to be looked at. Red and green are for the two that are
   * actually a choice.
   */
  const PRIORITIES = [
    { value: 'high', glyph: '↑', label: 'High priority' },
    { value: 'normal', glyph: '≡', label: 'Normal priority' },
    { value: 'low', glyph: '↓', label: 'Low priority' },
  ];

  /** Puts one on the button. `value` stays the source of truth — payload()
   *  reads it exactly as it did when this control was a <select>. */
  function setPriority(value) {
    const btn = document.getElementById('c-priority');
    if (!btn) return;
    const p = PRIORITIES.find((x) => x.value === value) || PRIORITIES[1];
    btn.value = p.value;
    btn.textContent = p.glyph;
    btn.dataset.priority = p.value;
    btn.title = I18n.t(p.label);
  }

  /* ---------- follow-up reminder ----------
   * "Remind me if nobody answers within N days" (server/followUps.js). The
   * choices are the server's own list (followUps.ALLOWED_DAYS); each has its
   * own label rather than one "{n} days" template, because Slovenian inflects
   * the noun by number — čez 1 dan, čez 2 dneva, čez 3 dni — and no template
   * gets all three right. */
  const FOLLOW_UP_CHOICES = [
    [1, 'In 1 day'], [2, 'In 2 days'], [3, 'In 3 days'], [5, 'In 5 days'], [7, 'In 7 days'],
  ];
  let followUpDays = 0;
  function setFollowUp(days) {
    followUpDays = FOLLOW_UP_CHOICES.some(([d]) => d === days) ? days : 0;
    const btn = document.getElementById('c-followup');
    if (!btn) return;
    // The number on the button is the point: a reminder that is armed has to
    // be visible before Send, not discovered afterwards.
    btn.textContent = followUpDays ? `⏰ ${followUpDays} d` : '⏰';
    btn.classList.toggle('on', !!followUpDays);
    const label = FOLLOW_UP_CHOICES.find(([d]) => d === followUpDays)?.[1];
    btn.title = followUpDays
      ? `${I18n.t('Remind me if nobody replies')}: ${I18n.t(label)}`
      : I18n.t('Remind me if nobody replies');
  }

  /** A reminder was just sent with a message — make the app start asking about
   *  reminders on its background polls (app.js#reconcileFolders asks only while
   *  one is waiting). Counted here rather than fetched: the server keeps the
   *  reminder once the message has actually gone out, which is after /api/send
   *  has already answered, so asking now would race it and see nothing. The
   *  next poll replaces this guess with the server's own number. */
  function noteFollowUpArmed(p) {
    if (!p.followUpDays || !state.followUps) return;
    state.followUps.waiting = (state.followUps.waiting || 0) + 1;
  }

  // Whether the composer opens enlarged on THIS machine. A dedicated key rather
  // than a device setting: this is window position, the same kind of thing
  // Dialog's own `hmelj.dialogExpanded` and the remembered Settings tab keep —
  // not a preference worth syncing to the server and pushing onto a phone.
  const COMPOSE_LARGE_KEY = 'hmelj-compose-large';
  // What signatureHtml() wraps a signature in: ONE node, so switching identity
  // removes the whole thing, spacing included — and so a signature already in
  // the body (a reopened draft) can be recognised rather than duplicated.
  const SIGNATURE_WRAP = 'signature-wrap';
  // "no signature on this message" as a chosenSignatureId value. A sentinel
  // rather than null, because null already means something else and means it
  // usefully — "nobody has chosen, use the identity's default".
  const NO_SIGNATURE = '__none__';
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
  let composeContext = 'new'; // context passed to open() ('new' | 'reply' | 'forward') — re-used by applySignatureForIdentity when the From identity changes mid-compose, so a signature configured "new messages only" still respects that on a reply/forward
  let insertedSignatureNode = null; // rich mode: the actual DOM node last auto-inserted by applySignatureForIdentity, so switching identity can cleanly remove it — null if none, or if the user may have edited/removed it (see applySignatureForIdentity)
  let insertedSignaturePlainText = ''; // plain mode: the exact text last auto-inserted, same purpose
  let plainQuoteTail = ''; // plain mode: the quoted original's text, as it sits at the END of the textarea — see quotedTailText
  let inFlightSave = null; // the Promise from a saveDraftNow() currently in flight, or null — see requestClose/discardDraft
  let closing = false; // a requestClose() is already deciding (awaiting an in-flight save, or with its prompt up) — see requestClose
  let currentFont = 'system-ui'; // what the toolbar's Aa button last applied — the state the old <select> kept in its .value
  // Which of the identity's signatures THIS message uses, when the user has
  // picked one from the ⋯ menu. null means "whatever the identity says",
  // which is the answer for every message nobody picks for. Reset by open().
  let chosenSignatureId = null;

  const el = () => document.getElementById('compose-window');

  /** Phone-width, where the composer is always full-page. One definition, used
   *  by open() and by the enlarge button, so the two cannot disagree about
   *  which screens the remembered size applies to. */
  const isNarrow = () => matchMedia('(max-width: 900px)').matches;
  const wantsLarge = () => {
    try { return localStorage.getItem(COMPOSE_LARGE_KEY) === '1'; } catch { return false; }
  };

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

  const RECIPIENT_FIELDS = ['c-to', 'c-cc', 'c-bcc'];

  /**
   * Sizes a recipient field to its contents.
   *
   * These are textareas rather than inputs so that a dozen addresses wrap
   * instead of running off the right-hand edge (see .compose-row textarea in
   * app.css). Nothing else about them changes: a textarea has the same `value`,
   * `selectionStart` and `setSelectionRange` the autocomplete and the
   * backspace-a-whole-recipient handling are built on.
   *
   * height:auto first, or scrollHeight only ever reports the height it already
   * has and the field can grow but never shrink again.
   */
  function growRecipient(el) {
    if (!el) return;
    // An EMPTY field is one row, always. scrollHeight measures what is drawn,
    // and for an empty textarea that is the PLACEHOLDER — which wraps on a
    // narrow field (a phone, or any field at a larger UI font size), so a To
    // line with nothing typed in it was being grown to two rows by its own
    // hint text. Clearing the inline height hands it back to the stylesheet's
    // single row and lets the hint clip, which is what a hint is for.
    if (!el.value) { el.style.height = ''; return; }
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }
  function growRecipients() { RECIPIENT_FIELDS.forEach((id) => growRecipient(document.getElementById(id))); }

  /** Cc and Bcc together — they are one disclosure, opened by one button. */
  function setCcVisible(on) {
    document.querySelectorAll('.cc-row').forEach((r) => (r.hidden = !on));
    document.getElementById('btn-cc-toggle')?.setAttribute('aria-expanded', String(!!on));
    // A hidden element has no scrollHeight worth reading, so a field filled in
    // while the row was collapsed comes out one line tall until it is measured
    // again here — which is exactly the reply-all case that prompted all this.
    if (on) growRecipients();
  }

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

  /** One identity's signatures, always an array. The server normalises this
   *  shape on every read and write (store.js#normalizeIdentities) — this is the
   *  belt to that's braces, for an identity that reached the composer some
   *  other way (a draft reopened against a list fetched before the migration). */
  function signaturesOf(id) {
    return Array.isArray(id?.signatures) ? id.signatures : [];
  }

  /** Which signature a message uses: the one explicitly picked for THIS message,
   *  else the identity's default, else its first. */
  function signatureFor(id, sigId = chosenSignatureId) {
    const list = signaturesOf(id);
    if (!list.length) return null;
    if (sigId === NO_SIGNATURE) return null;
    return list.find((s) => s.id === sigId)
      || list.find((s) => s.id === id.defaultSignatureId)
      || list[0];
  }

  /**
   * `force` skips the signatureOn check.
   *
   * That setting answers "should one be added on its own", and picking one out
   * of the ⋯ menu is not on its own — refusing to insert a signature somebody
   * has just asked for, because the identity is configured not to add one
   * automatically, would read as the menu being broken.
   */
  function signatureHtml(id, context /* new | reply | forward */, { sigId = chosenSignatureId, force = false } = {}) {
    const sig = signatureFor(id, sigId);
    if (!sig?.html) return '';
    const on = id.signatureOn || 'new-reply'; // new | new-reply | always | never
    if (!force) {
      if (on === 'never') return '';
      if (on === 'new' && context !== 'new') return '';
    }
    // Signatures written with the old plain-text editor still have literal
    // `\n` line breaks and need converting; ones from the newer rich HTML
    // editor (Settings > Identities) already contain real markup and should
    // pass through untouched.
    const body = /<[a-z][\s\S]*>/i.test(sig.html) ? sig.html : sig.html.replace(/\n/g, '<br>');
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
  function applySignatureForIdentity(id, context, { sigId = chosenSignatureId, force = false } = {}) {
    const sig = signatureHtml(id, context, { sigId, force });
    // A body that ALREADY carries a signature is a message coming back to be
    // edited — a draft reopened, or a cancelled undo-send. The one it has is
    // the one its author saved, so it is adopted rather than added to; without
    // this, open() appended a second copy every time a draft was reopened, and
    // a third the time after that.
    //
    // Adopted, not merely skipped: `insertedSignatureNode` is what lets a later
    // identity switch replace the signature instead of stacking another one
    // under it, and after a reopen that pointer would otherwise be null.
    // …but not when the user has just PICKED one: they are looking at the
    // signature they want replaced, and adopting it would make the menu do
    // nothing at all.
    if (!force && adoptExistingSignature()) return;
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
    // No button to show or hide any more — templates moved into the ⋯ menu,
    // which asks `templates.length` each time it opens (see openMoreMenu). The
    // rule is the same one this function used to enforce: nothing on offer,
    // nothing shown.
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
      // Reached from the ⋯ menu now, which took focus off the editor on its way
      // open — so the caret has to be put back before it can be found, or every
      // template would take the "caret isn't in the body" path below and land at
      // the end of the message instead of where the user left off.
      restoreEditorRange();
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

  /**
   * Swap this message's sign-off. Only offered when the identity has more than
   * one (see openMoreMenu) — with a single signature there is nothing to choose
   * between, and the entry would open a menu with one entry and "None".
   */
  function showSignatureMenu(x, y) {
    const id = currentIdentity();
    const list = signaturesOf(id);
    if (!list.length) return;
    const active = signatureFor(id);
    const pick = (sigId) => {
      chosenSignatureId = sigId;
      // force: the pick IS the instruction, whatever signatureOn says.
      applySignatureForIdentity(id, composeContext, { sigId, force: true });
      dirty = true;
    };
    openCtxMenu([
      ...list.map((s) => ({
        // The user's own words — not run through I18n, same as the template
        // menu: a signature called "Kratki" must not be looked up.
        // esc: openCtxMenu injects its labels as HTML (it runs them through
        // I18n.t), so escaping belongs here rather than there — the same rule
        // showContactRowMenu's own comment states for a contact's name.
        label: `${active?.id === s.id ? '✓ ' : '  '}${esc(s.name)}`,
        onClick: () => pick(s.id),
      })),
      { label: chosenSignatureId === NO_SIGNATURE ? '✓ None' : '  None', onClick: () => pick(NO_SIGNATURE) },
    ], x, y);
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
    // media query (see app.css). Unconditional there, and deliberately not
    // remembered: a phone must never be able to persist "small" and then open
    // into a panel it cannot use.
    //
    // On a DESKTOP the enlarge button's last answer is remembered instead of
    // reset every time, which is the whole reason this reads a stored value at
    // all — somebody who works in the big window was re-enlarging it on every
    // single message.
    el().classList.toggle('large', isNarrow() || wantsLarge());
    closeContactSuggest();
    renderAttachments();
    const idSel = document.getElementById('c-identity');
    const wantId = identityId || defaultIdentityId();
    if (wantId && idSel.querySelector(`option[value="${CSS.escape(wantId)}"]`)) idSel.value = wantId;
    document.getElementById('c-to').value = to;
    document.getElementById('c-cc').value = cc;
    document.getElementById('c-bcc').value = '';
    // Shown when this message HAS a Cc, hidden when it does not — decided here
    // every time rather than left as whatever the last window was.
    //
    // Both halves of that were wrong before. Reply-all to a message with three
    // people copied put them in Cc and left the row hidden, so the composer
    // said "To: Simona" while it was about to write to four people — the one
    // moment the field is worth seeing. And because the compose window is shown
    // and hidden rather than rebuilt, revealing Cc once by hand left it open on
    // every unrelated message afterwards; it looked like a remembered
    // preference, but nothing was remembering anything.
    setCcVisible(!!cc);
    // The values above were just assigned; a field that came in with ten
    // addresses has to be measured before it is looked at, not on first keypress.
    growRecipients();
    document.getElementById('c-subject').value = subject;
    setPriority('normal');
    // A reminder belongs to one message. Never carried into the next composer,
    // and not restored with a draft either — choosing it is part of sending.
    setFollowUp(0);
    document.getElementById('c-receipt').checked = !!state.settings.requestReadReceipt;
    document.getElementById('compose-title').textContent = subject || 'New message';
    document.getElementById('draft-status').textContent = '';
    const plain = state.settings.composeFormat === 'plain';
    document.getElementById('c-plain').checked = plain;
    togglePlain(plain, false);
    composeContext = context;
    insertedSignatureNode = null;
    insertedSignaturePlainText = '';
    // The body below is about to be replaced wholesale, so a range saved while
    // writing the last message points at nodes that are on their way out.
    savedRange = null;
    // Per message, not per session: the sign-off you chose for one mail is not
    // an instruction about the next one.
    chosenSignatureId = null;
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
    placeInitialFocus(to, context, plain);
    // Deferred one tick: reply()/forward() call open() and then set replyMeta
    // synchronously right after it returns — capturing the pristine snapshot
    // inside open() itself would miss those fields and make an untouched
    // reply/forward always look "changed" relative to its own baseline.
    setTimeout(() => { pristinePayload = JSON.stringify(payload()); }, 0);
    // After the body is populated, so the first check sees the real text — and
    // late enough that the signature is already in place to be skipped.
    Proofread.open({ plain });
  }

  /**
   * Where the caret goes when a composer opens — and, just as much, what the
   * user is looking at when it does.
   *
   * TWO things scroll in here: the panel (.compose-body) and the editor itself
   * (.compose-editor is overflow-y:auto). The window is shown and hidden rather
   * than rebuilt, so both keep whatever offset the LAST message left behind,
   * and replacing the editor's innerHTML does not clear it — a browser only
   * clamps scrollTop when the new content is shorter than the old scroll
   * position. So a reply opened wherever the previous one happened to be left,
   * which in practice meant halfway down somebody else's quoted mail.
   *
   * The caret was part of the same complaint. A reply arrives with its
   * recipients and its subject already filled in, so the only thing left to do
   * with it is write — and focus went to the Subject field, one Tab short of
   * the place the message actually gets typed. It now starts on the first line
   * of the writing area, above the signature and above the quote. A new message
   * still starts at To, and one opened with a recipient already known still
   * starts at Subject: there, the empty field IS the next thing to do.
   *
   * A FORWARD is the one that looks like a reply and is not. Its body is
   * already written — by somebody else — and its subject is already filled in;
   * the one thing it does not know is who it is going to, and that is the first
   * thing anyone forwarding a message types. So it starts at To, like a new
   * message, even though it carries a quote like a reply.
   */
  function placeInitialFocus(to, context, plain) {
    const panel = document.getElementById('compose-body');
    const ed = document.getElementById(plain ? 'c-editor-plain' : 'c-editor');
    const writing = plain ? null : (ed.querySelector(`:scope > .${BODY_CLASS}`) || ed);

    // preventScroll on every one of these: the scroll position is settled
    // below, deliberately, and letting focus() nudge it first only means
    // undoing that.
    if (context === 'forward') {
      document.getElementById('c-to').focus({ preventScroll: true });
    } else if (context !== 'reply') {
      (to ? document.getElementById('c-subject') : document.getElementById('c-to')).focus({ preventScroll: true });
    } else if (plain) {
      ed.focus({ preventScroll: true });
      ed.setSelectionRange(0, 0);
    } else {
      ed.focus({ preventScroll: true });
      // Offset 0 of the first line, not of the wrapper: on the wrapper the
      // caret sits before the first block rather than inside it, and the first
      // character typed can end up outside the styled writing area.
      const first = writing.firstChild || writing;
      const range = document.createRange();
      range.setStart(first, 0);
      range.collapse(true);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }

    // Clear the inherited position, always — this is the part that was missing.
    panel.scrollTop = 0;
    ed.scrollTop = 0;
    // With "quote above the reply" the writing area is BELOW the quoted
    // original, so the top is exactly where the caret is not. `nearest` does
    // nothing in the ordinary quote-below case, where the line is already on
    // screen after the reset.
    if (context === 'reply' && writing) writing.scrollIntoView({ block: 'nearest' });
  }

  function htmlToText(html) {
    const d = document.createElement('div');
    d.innerHTML = (html || '').replace(/<br\s*\/?>(?!$)/gi, '\n').replace(/<\/(div|p|blockquote)>/gi, '\n');
    return d.textContent;
  }

  /** Undoes Hmelj's own quote collapsing (server/quoteCollapse.js) in a message
   *  that is about to be quoted into a new one.
   *
   *  That collapsing is a rendering decision made for the READING pane, and it
   *  is made with an inline display:none!important plus a button that only does
   *  anything inside the sandboxed message frame. Carried into an outgoing
   *  message, both stop being decorations: the recipient's client has no such
   *  handler, so the forwarded mail leaves here permanently invisible with a
   *  dead ⋯ where it should have been. Reply to a reply, or forward anything
   *  that was itself a reply, and this is the difference between sending the
   *  conversation and sending a button. */
  function unhideCollapsedQuote(html) {
    if (!html || !html.includes('hmelj-quote')) return html;
    const d = document.createElement('div');
    d.innerHTML = html;
    for (const b of d.querySelectorAll('.hmelj-quote-toggle')) b.remove();
    for (const el of d.querySelectorAll('.hmelj-quoted, .hmelj-quote-shown')) {
      el.classList.remove('hmelj-quoted', 'hmelj-quote-shown');
      if (!el.getAttribute('class')) el.removeAttribute('class');
      el.style.removeProperty('display');
      if (!el.getAttribute('style')) el.removeAttribute('style');
    }
    return d.innerHTML;
  }

  function quoteBlock(msg) {
    const when = fmtDate(msg.date, { long: true });
    const who = msg.from?.[0] ? (msg.from[0].name || msg.from[0].address) : '';
    // Same linkifying the reading pane does (MessageFrame.linkifyText): a
    // plain-text original quoted into an HTML reply keeps its URLs clickable
    // for whoever reads the reply, instead of quietly demoting them to text.
    // Only quoted mail — editDraft() below deliberately leaves the user's own
    // draft byte-for-byte as they wrote it.
    const inner = unhideCollapsedQuote(msg.html) || `<pre>${MessageFrame.linkifyText(msg.text)}</pre>`;
    // Written into the outgoing mail, so translated HERE: the page translator
    // never touches the editor's contents (i18n.js skips .compose-editor), and
    // must not — everything else in there is what the user typed.
    // Function replacers: a sender named "Ana $& Co" must come out as written,
    // not with the $& expanded the way a string replacement would.
    const header = I18n.t('On {when}, {who} wrote:').replace('{when}', () => when).replace('{who}', () => who);
    return `<br><div class="quote-header">${esc(header)}</div>
<blockquote style="${QUOTE_STYLE}">${inner}</blockquote>`;
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
      bodyHtml: withQuote(msg, `<div>---------- ${esc(I18n.t('Forwarded message'))} ----------</div>`, 'below'),
      // Not 'reply', only because of where the caret goes (placeInitialFocus) —
      // everything a signature decides treats the two the same, since the
      // per-identity rule only ever asks whether this is a NEW message.
      context: 'forward',
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
    // Same two faults restoreDraftParts had, and this one was worse for having
    // no error check: without ?account= the server answers 400 with a JSON body,
    // and `r.blob()` turns that sentence into a file — so forwarding from All
    // inboxes attached the error message under the original filename. The
    // account comes from the message being forwarded, not from whatever is on
    // screen.
    const fwdAccount = msg.__account || null;
    for (const a of msg.attachments || []) {
      if (a.inlineUsed) continue;
      fetch(API.attachmentUrl(folder, msg.uid, a.index, fwdAccount), { credentials: 'same-origin' })
        .then(async (r) => {
          if (!r.ok) {
            const said = await r.json().then((j) => j?.error).catch(() => null);
            throw new Error(said || `HTTP ${r.status}`);
          }
          return r.blob();
        })
        .then((b) => addBlob(b, a.filename, a.contentType))
        .catch((e) => toast(`${I18n.t('Could not attach')} ${a.filename || ''}: ${e.message}`, 6000));
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
    // open() above already showed them for a Cc; a queued message with only a
    // Bcc is the case it cannot see, since open() takes no bcc.
    if (p.cc || p.bcc) setCcVisible(true);
    growRecipients();
    setPriority(p.priority || 'normal');
    document.getElementById('c-receipt').checked = !!p.readReceipt;
    // A message recalled by Undo, or a scheduled one taken back, keeps the
    // reminder it was going to go out with — it is the same message.
    setFollowUp(Number(p.followUpDays) || 0);
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

  /**
   * A draft, back in the composer.
   *
   * `link` is the "unfinished answer to X" record (server/draftLinks.js), passed
   * when the draft was opened from the ✎ on the message it answers. It carries
   * what a draft on the mail server cannot: a draft is APPENDed from its body
   * and recipients alone (index.js#saveDraft), with no In-Reply-To and no
   * References, so a reply saved yesterday and sent today used to arrive as the
   * start of a new thread and leave the original unmarked. Restoring replyMeta
   * here is what makes continuing a reply produce a reply.
   *
   * Opening the same draft from the Drafts FOLDER passes no link and behaves
   * exactly as before — there is nothing there to recover the linkage from.
   */
  function editDraft(msg, link = null) {
    open({
      to: msg.to.map((a) => a.address).join(', '),
      cc: msg.cc.map((a) => a.address).join(', '),
      subject: msg.subject === '(no subject)' ? '' : msg.subject,
      bodyHtml: msg.html || `<pre>${esc(msg.text || '')}</pre>`,
      context: 'new',
    });
    draftUid = msg.uid;
    // After open(), which clears it — same ordering, and the same reason, as
    // reply() and forward() above.
    if (link?.original) {
      replyMeta = {
        inReplyTo: link.inReplyTo || undefined,
        references: link.references || undefined,
        original: link.original,
      };
    }
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
    // The DRAFT's own account, not the ambient one. This URL used to be built by
    // hand with no ?account= at all, which the server answers — correctly — with
    // 400 "No mail account selected". Any draft opened from All inboxes (where
    // there is no ambient account) or from any view other than its own account's
    // therefore came back with every attachment missing and "part 0: HTTP 400".
    // API.attachmentUrl is the one place that knows how to address a part; the
    // same mistake has been made here twice before, which is why it exists.
    const accountId = msg.__account || null;
    const uid = msg.uid;
    const referenced = bodyCids();
    const wasDraft = draftUid;
    try {
      await Promise.all(parts.map(async (a) => {
        const r = await fetch(API.attachmentUrl(folder, uid, a.index, accountId), { credentials: 'same-origin' });
        // Every /api route answers a failure as {error}. Saying "HTTP 400" when
        // the server wrote a sentence explaining itself is the difference
        // between a report that names the bug and one that needs the server log
        // to decode — the same reasoning as attachmentViewer.js#fetchWithProgress.
        if (!r.ok) {
          const said = await r.json().then((j) => j?.error).catch(() => null);
          throw new Error(`${a.filename || `part ${a.index}`}: ${said || `HTTP ${r.status}`}`);
        }
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
      : `<span class="attach-chip" title="${escAttr(a.filename)}">📎 <span class="attach-name">${esc(a.filename)}</span> <button data-i="${i}" title="Remove">✕</button></span>`)).join('');
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
    // As wide as the field, but never narrower than a readable address and
    // never wider than the screen. On a phone the field is the narrow one, and
    // 220px was not enough for a name and an address together.
    box.style.width = Math.min(Math.max(r.width, 260), innerWidth - 16) + 'px';
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
      // Name and address as two elements, so CSS can lay them out on one line
      // where there is room and stack them where there is not. On a phone the
      // box is barely wider than the field, and one nowrap line meant every row
      // read "simona <sim…" — the names matched, the addresses were the thing
      // you needed to tell them apart, and the address was the half that got
      // cut. A row with no name (an address typed straight in) is one element,
      // as it always was.
      const parts = o.name && o.email
        ? `<span class="cs-name">${esc(o.name)}</span><span class="cs-addr">&lt;${esc(o.email)}&gt;</span>`
        : `<span class="cs-name">${esc(o.label)}</span>`;
      b.innerHTML = armed
        ? `🗑 ${esc(I18n.t('Remove from contacts?'))} <span class="cs-hint">${esc(I18n.t('press Del again'))}</span>`
        : parts + (o.own ? ` <span class="cs-own">${esc(I18n.t('you'))}</span>` : '');
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
      // stopPropagation for the same reason the Escape branch below has it:
      // this keypress is SPENT. It matters somewhere compose never goes — the
      // calendar's event editor, where the field sits inside a Dialog whose own
      // handler reads a bubbling Enter as "Save". Accepting a contact submitted
      // the whole dialog instead.
      e.stopPropagation();
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
      //
      // A GROUP row carries no `contact` either, so the same test skips it: a
      // group is edited in Settings › Contacts, and deleting one from here
      // would take away a list somebody built rather than one dead address.
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
  /**
   * Where the recipient containing `caret` starts — the index just past the
   * separator in front of it, or 0 for the first one.
   *
   * Quote-aware, deliberately: the comma in `"Novak, Bo" <bo@x.si>` is part of
   * somebody's name, not a separator, and a plain lastIndexOf(',') cuts that
   * person in half. Same thing addressparser knows on the server side (see
   * server/contactGroups.js, which relies on exactly this).
   */
  function recipientStart(value, caret) {
    let start = 0;
    let inQuotes = false;
    for (let i = 0; i < caret; i++) {
      const ch = value[i];
      if (ch === '"') inQuotes = !inQuotes;
      else if (!inQuotes && (ch === ',' || ch === ';')) start = i + 1;
    }
    return start;
  }

  /**
   * Backspace at a recipient boundary takes the WHOLE recipient, not a letter
   * of it — what Outlook does with its chips, and what these fields could not
   * do because they are plain <input>s holding one long string.
   *
   * Reported after picking a group from the suggestions: the dropdown commits
   * `👥 Družina, ` and leaves the caret past the separator, so Backspace ate
   * "a", "n", "i"… one press at a time, and unpicking a group meant eleven of
   * them.
   *
   * Two rules keep this from getting in the way of ordinary editing:
   *
   *   - It only fires AT A BOUNDARY — when everything between the previous
   *     separator and the caret is whitespace. Backspace in the middle of an
   *     address still deletes a character, because that is what fixing a typo
   *     needs, and there is no way to tell a finished address from one being
   *     typed towards.
   *   - The first press SELECTS the recipient rather than deleting it, exactly
   *     as Outlook selects a chip. This is data somebody typed: showing what
   *     the next press will take is worth one keystroke. The second press is
   *     then the browser's own delete-the-selection, so nothing here has to
   *     handle it — and typing instead simply replaces it.
   *
   * Backspace only, not Delete: Delete already means "remove this contact from
   * the address book" while the dropdown is open (see onContactSuggestKeydown),
   * and one key cannot mean two destructive things.
   */
  function onRecipientBackspace(e, inputEl) {
    if (e.key !== 'Backspace' || e.ctrlKey || e.metaKey || e.altKey) return;
    const value = inputEl.value;
    const caret = inputEl.selectionStart;
    // A range is already selected — including the one a previous press made.
    // Backspace means "delete that", which is the default.
    if (caret !== inputEl.selectionEnd) return;
    const start = recipientStart(value, caret);
    if (value.slice(start, caret).trim()) return; // mid-recipient: ordinary character delete
    if (!start) return;                           // nothing in front of the caret to take
    const prevStart = recipientStart(value, start - 1);
    const prev = value.slice(prevStart, start - 1);
    if (!prev.trim()) return;                     // an empty segment (", ,") — let it collapse a character at a time
    e.preventDefault();
    // From the recipient's first non-space character through the caret, so the
    // separator and the space after it go with it and the field is left clean
    // rather than ending in a stray comma.
    inputEl.setSelectionRange(prevStart + (prev.length - prev.trimStart().length), caret);
    // The box is offering matches for an empty segment's worth of nothing, and
    // it would sit over the selection we just made.
    closeContactSuggest();
  }

  /* ---------- the formatting toolbar ----------
   *
   * Three pieces, in dependency order: keeping the editor's selection alive
   * across a click that happens somewhere else, running a command with the
   * right markup dialect, and the little anchored panel the pickers draw into.
   */

  /**
   * The editor selection, saved so a control OUTSIDE the editor can act on it.
   *
   * The plain toolbar buttons get away with `mousedown → preventDefault`, which
   * stops the editor being blurred at all. That does not survive a POPOVER: the
   * click that runs the command happens in a different element, a frame later,
   * with the editor long since blurred — and `document.execCommand` acts on the
   * focused element's selection, so without this every picker would format the
   * top of the document instead of what was selected.
   *
   * Saved on pointerdown anywhere in the toolbar (before focus moves), restored
   * immediately before the command runs. Same shape as the createLink handler
   * below and as settings.js#wireSignatureEditors, which both solved this once
   * already for a dialog.
   */
  let savedRange = null;

  /**
   * Which contenteditable the toolbar engine is currently acting on.
   *
   * The composer's own editor is only one of three: Settings' signature and
   * template editors get the SAME toolbar (see wireRichEditor, exported at the
   * bottom of this file), because "the options I have when writing a message"
   * is exactly what somebody expects when writing a template. Everything below
   * therefore asks `editorEl()` rather than reaching for `#c-editor` by name.
   */
  let activeEditor = null;
  const editorEl = () => activeEditor || document.getElementById('c-editor');
  // editor -> { toolbar, onChange, menu } for each wired editor. A WeakMap, so
  // a Settings editor that has been re-rendered away takes its entry with it.
  const wiredEditors = new WeakMap();

  function saveEditorRange() {
    const ed = editorEl();
    const sel = window.getSelection();
    if (!sel?.rangeCount) return;
    const r = sel.getRangeAt(0);
    // Only a selection that is actually IN the editor. A caret left in the
    // subject line, or in the page behind, is not something to restore into —
    // and restoring it would run the command against whatever it points at.
    if (ed.contains(r.commonAncestorContainer)) savedRange = r.cloneRange();
  }

  /** Puts the saved selection back and focuses the editor. Separate from
   *  withEditorSelection because insertTemplate needs the caret back without
   *  running a command through it. */
  function restoreEditorRange() {
    const ed = editorEl();
    ed.focus();
    // `contains`, not merely "is there one": open() rebuilds the editor's whole
    // contents, so a range saved while writing the LAST message points at nodes
    // that have since been thrown away. Handing one of those to addRange puts
    // the caret nowhere and the command that follows would act on nothing.
    if (!savedRange || !ed.contains(savedRange.commonAncestorContainer)) return;
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(savedRange);
  }

  /** Runs `fn` with the editor focused and its saved selection back in place. */
  function withEditorSelection(fn) {
    restoreEditorRange();
    fn();
    // The command moved/replaced it; re-save so a second picker in a row acts
    // on where the first one left off rather than on a stale range.
    saveEditorRange();
    const wired = wiredEditors.get(editorEl());
    // `dirty` belongs to the COMPOSER; a signature editor has its own idea of
    // what to do when its content changes (write the hidden field Settings
    // saves from). Each editor says so when it is wired.
    if (wired) wired.onChange?.();
    else dirty = true;
    syncToolbarState();
  }

  /**
   * One execCommand, with `styleWithCSS` set per command.
   *
   * The default is wrong for two of them, and what comes out is markup somebody
   * else's mail client has to render:
   *
   *   - **indent/outdent MUST use CSS.** With styleWithCSS off, Chrome
   *     implements indent by wrapping the selection in a `<blockquote>` — which
   *     is indistinguishable from what the ❝ Quote button makes, so indenting
   *     inside a quote, or quoting something indented, would produce a mess
   *     neither button could undo.
   *   - **alignment MUST use CSS**, or it emits the deprecated `align=`
   *     attribute, which fewer clients honour than `text-align`.
   *
   * Everything else deliberately uses the OLD dialect: `<font face>`,
   * `<font size>`, `<font color>`, `<b>`, `<i>`. That is what the font control
   * has always emitted here, one convention in one file beats two, and Outlook
   * renders presentational tags without argument. `font` is already in the
   * reading pane's allowedTags (server/index.js), so it survives being read back.
   */
  const CSS_COMMANDS = new Set(['indent', 'outdent', 'justifyLeft', 'justifyCenter', 'justifyRight', 'hiliteColor']);

  function exec(cmd, value = null) {
    withEditorSelection(() => {
      try { document.execCommand('styleWithCSS', false, CSS_COMMANDS.has(cmd)); } catch { /* not everywhere */ }
      document.execCommand(cmd, false, value);
    });
  }

  /**
   * `formatBlock` plus the inline style the result has to carry.
   *
   * A bare `<blockquote>` or `<pre>` is styled by the reader's client, which for
   * Outlook means not at all — so a quote would arrive as an ordinary paragraph
   * and a code block as ordinary text. formatBlock is still what makes the
   * block (it handles a multi-paragraph selection properly, which hand-built
   * insertHTML does not); this only dresses what it made.
   */
  function formatBlockStyled(tag, style) {
    withEditorSelection(() => {
      try { document.execCommand('styleWithCSS', false, false); } catch { /* ignore */ }
      document.execCommand('formatBlock', false, tag);
      const sel = window.getSelection();
      let node = sel?.anchorNode;
      const ed = editorEl();
      while (node && node !== ed) {
        if (node.nodeType === 1 && node.tagName.toLowerCase() === tag) { node.setAttribute('style', style); return; }
        node = node.parentNode;
      }
    });
  }

  /* ---------- the anchored picker panel ----------
   * openCtxMenu (app.js) is a list of text buttons and is exactly right for the
   * ⋯ menu, which is one. It cannot draw a swatch grid or an emoji grid, so the
   * four pickers use this instead: the same transparent backdrop and the same
   * safe-area clamp, around arbitrary HTML.
   */
  let panelEl = null;
  let panelBackdrop = null;

  function closeToolbarPanel() {
    panelEl?.remove();
    panelBackdrop?.remove();
    panelEl = panelBackdrop = null;
  }

  /**
   * Opens `html` in a panel under `anchorEl`. Returns the element so the caller
   * can wire its own clicks.
   *
   * Positioned AFTER it is in the document, like openCtxMenu and
   * positionContactSuggest: its size is not knowable until the browser has laid
   * it out, and clamping against a guess is how a panel ends up half off a
   * phone screen. Clamped into the safe area rather than the viewport, for the
   * reason openCtxMenu's own comment gives — in landscape the cutout and the
   * navigation bar are on the sides.
   */
  function openToolbarPanel(anchorEl, html) {
    closeToolbarPanel();
    panelBackdrop = document.createElement('div');
    panelBackdrop.className = 'ctx-menu-backdrop';
    // mousedown, not click: a click would land after the button's own handler
    // had already reopened the panel, so tapping the same button twice would
    // never close it.
    panelBackdrop.addEventListener('mousedown', closeToolbarPanel);
    document.body.appendChild(panelBackdrop);

    panelEl = document.createElement('div');
    panelEl.className = 'compose-popover';
    panelEl.innerHTML = html;
    document.body.appendChild(panelEl);

    const inset = safeInsets();
    const r = panelEl.getBoundingClientRect();
    const a = anchorEl.getBoundingClientRect();
    const left = inset.left + 8, right = inset.right + 8, top = inset.top + 8, bottom = inset.bottom + 8;
    panelEl.style.left = Math.max(left, Math.min(a.left, innerWidth - right - r.width)) + 'px';
    // Below the button when it fits, above it when it does not — a picker on the
    // toolbar of a composer sitting at the bottom of the screen usually does not.
    const below = a.bottom + 4;
    panelEl.style.top = (below + r.height <= innerHeight - bottom ? below : Math.max(top, a.top - r.height - 4)) + 'px';
    return panelEl;
  }

  /* ---------- the toolbar itself: markup, state, wiring ----------
   *
   * Built here rather than written into index.html, because there are three of
   * these: the composer's, and the signature and template editors in Settings.
   * One builder is what keeps them from drifting apart — "the options I get
   * when writing a message" is exactly what somebody expects when writing a
   * template, and a second copy of this markup would be that promise decaying
   * one button at a time.
   */

  /** The commands whose buttons light up when the caret is inside them.
   *  queryCommandState answers for all of these; anything it cannot answer for
   *  (font, size, colour) simply has no pressed state. */
  const STATE_COMMANDS = ['bold', 'italic', 'underline', 'strikeThrough',
    'insertUnorderedList', 'insertOrderedList', 'justifyLeft', 'justifyCenter', 'justifyRight'];

  /**
   * The toolbar's buttons, as HTML.
   *
   * `extras` is appended by Settings, whose editors have two buttons the
   * composer has no use for (insert an image, edit the HTML source).
   */
  function richToolbarHtml({ extras = '' } = {}) {
    const b = (attrs, label, title) =>
      `<button type="button" ${attrs} title="${escAttr(I18n.t(title))}" tabindex="-1">${label}</button>`;
    return [
      b('data-panel="font" class="tb-font"', `Aa<span class="tb-caret">▾</span>`, 'Font'),
      b('data-panel="size"', `↕<span class="tb-caret">▾</span>`, 'Text size'),
      '<span class="tb-sep"></span>',
      b('data-cmd="bold"', '<b>B</b>', 'Bold'),
      b('data-cmd="italic"', '<i>I</i>', 'Italic'),
      b('data-cmd="underline"', '<u>U</u>', 'Underline'),
      b('data-cmd="strikeThrough"', '<s>S</s>', 'Strikethrough'),
      b('data-panel="color"', '<span class="tb-color-a">A</span><span class="tb-caret">▾</span>', 'Text colour'),
      '<span class="tb-sep"></span>',
      b('data-cmd="insertUnorderedList"', '•≡', 'Bullet list'),
      b('data-cmd="insertOrderedList"', '1≡', 'Numbered list'),
      b('data-cmd="createLink"', '🔗', 'Insert link'),
      b('data-panel="emoji"', '🙂', 'Emoji'),
      '<span class="tb-sep"></span>',
      b('data-more="1"', '⋯', 'More formatting'),
      extras,
    ].join('');
  }

  /**
   * Lights up the buttons for the formatting the caret is actually inside.
   *
   * Without this the toolbar is write-only: you can turn italic on but the bar
   * never says whether the word you are standing in is italic, so the only way
   * to find out is to press the button and look at what happens.
   *
   * queryCommandState is deprecated and imperfect — it answers for the whole
   * selection, so a partly-bold selection reads false — but it is the only
   * thing that answers this question at all in a contenteditable, and it is the
   * same API execCommand (which this toolbar is built on) belongs to.
   */
  function syncToolbarState() {
    const ed = activeEditor || document.getElementById('c-editor');
    const wired = wiredEditors.get(ed);
    const toolbar = wired?.toolbar || document.getElementById('editor-toolbar');
    if (!toolbar) return;
    const sel = window.getSelection();
    // Only when the caret is really in THIS editor. Otherwise the bar would go
    // on reporting the state of wherever it was last, which is worse than
    // reporting nothing.
    const live = sel?.rangeCount && ed?.contains(sel.getRangeAt(0).commonAncestorContainer);
    for (const cmd of STATE_COMMANDS) {
      const btn = toolbar.querySelector(`button[data-cmd="${cmd}"]`);
      if (!btn) continue;
      let on = false;
      if (live) { try { on = document.queryCommandState(cmd); } catch { on = false; } }
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
  }

  /**
   * Gives one contenteditable the composer's toolbar.
   *
   * `toolbar` must already contain richToolbarHtml()'s buttons. `onChange` is
   * what this editor does when its content changes — the composer marks itself
   * dirty, a Settings editor writes back the hidden field it is saved from.
   * `menu: 'basic'` drops the two ⋯ entries that only mean something inside a
   * real message (insert a template, choose a signature).
   */
  function wireRichEditor(toolbar, editor, { onChange = null, menu = 'basic' } = {}) {
    wiredEditors.set(editor, { toolbar, onChange, menu });

    // Before focus moves anywhere. pointerdown covers mouse, pen and touch, and
    // fires early enough that the editor still holds the selection every
    // control here is about to act on. Capture, so a control that stops the
    // event for its own reasons cannot skip it.
    toolbar.addEventListener('pointerdown', () => {
      activeEditor = editor;
      saveEditorRange();
    }, true);

    toolbar.querySelectorAll('button[data-cmd]').forEach((btn) => {
      btn.addEventListener('mousedown', (e) => e.preventDefault()); // keep the selection
      btn.addEventListener('click', async () => {
        const cmd = btn.dataset.cmd;
        if (cmd === 'createLink') {
          // Dialog.prompt steals focus, so this is the saved-range path too.
          const url = await Dialog.prompt(I18n.t('Insert link'), { label: I18n.t('Link URL (https://…):'), placeholder: 'https://' });
          if (url) exec('createLink', url);
        } else {
          exec(cmd);
        }
      });
    });

    // One binding for all four pickers: they differ only in what they draw, and
    // a picker that is already open is closed rather than reopened, so its own
    // button dismisses it like any other toggle.
    const PANELS = { font: openFontPanel, size: openSizePanel, color: openColorPanel, emoji: openEmojiPanel };
    toolbar.querySelectorAll('button[data-panel]').forEach((btn) => {
      btn.addEventListener('mousedown', (e) => e.preventDefault());
      btn.addEventListener('click', () => {
        const already = panelEl?.dataset.panel === btn.dataset.panel;
        closeToolbarPanel();
        if (already) return;
        PANELS[btn.dataset.panel](btn);
        if (panelEl) panelEl.dataset.panel = btn.dataset.panel;
      });
    });

    const more = toolbar.querySelector('button[data-more]');
    more?.addEventListener('mousedown', (e) => e.preventDefault());
    more?.addEventListener('click', () => openMoreMenu(more, menu));

    editor.dataset.richEditor = '1'; // how the one selectionchange listener below finds us
    editor.addEventListener('focus', () => { activeEditor = editor; syncToolbarState(); });
    editor.addEventListener('input', () => {
      wiredEditors.get(editor)?.onChange?.();
      syncToolbarState();
    });
    startSelectionWatch();
  }

  /**
   * One document-level selectionchange listener, for every rich editor there
   * will ever be.
   *
   * The caret moving is what changes which buttons are lit, and selectionchange
   * is the only event that fires for every way of moving it — arrow keys, a
   * click, a drag, an undo. It only fires on `document`, so a per-editor
   * listener would mean a permanent one for every editor ever wired: Settings
   * re-renders its whole tab on each edit, so that would leak a listener per
   * signature per keystroke-ish interaction, each holding a detached editor
   * alive. Instead the editor is found FROM the selection.
   */
  let selectionWatching = false;
  function startSelectionWatch() {
    if (selectionWatching) return;
    selectionWatching = true;
    document.addEventListener('selectionchange', () => {
      const sel = window.getSelection();
      if (!sel?.rangeCount) return;
      const node = sel.getRangeAt(0).commonAncestorContainer;
      const host = (node.nodeType === 1 ? node : node.parentElement)?.closest('[data-rich-editor]');
      if (!host) return;
      activeEditor = host;
      syncToolbarState();
    });
  }

  /* ---------- the four pickers ---------- */

  /** The font list, each name drawn in its OWN face — the one thing the native
   *  <select> this replaces could not do, and the reason a font list is worth
   *  looking at rather than reading. */
  function openFontPanel(btn) {
    const current = currentFont;
    const rows = FONTS.map((f) => {
      const stack = FONT_STACK[f];
      const label = f === 'system-ui' ? I18n.t('System default') : f;
      return `<button type="button" class="pop-row" data-font="${escAttr(f)}"${stack ? ` style="font-family:${escAttr(stack)}"` : ''}>
        <span class="pop-tick">${f === current ? '✓' : ''}</span>${esc(label)}</button>`;
    }).join('');
    const panel = openToolbarPanel(btn, `<div class="pop-list">${rows}</div>`);
    panel.querySelectorAll('[data-font]').forEach((b) => b.addEventListener('click', () => {
      closeToolbarPanel();
      setFont(b.dataset.font, btn);
    }));
  }

  /** Applies a font to the selection AND to the editor's own display, so what
   *  is being typed looks like what will be sent. Split out of the old <select>
   *  change handler unchanged in substance. */
  function setFont(font, btn) {
    currentFont = font;
    exec('fontName', font);
    editorEl().style.fontFamily = FONT_STACK[font] || '';
    if (btn) btn.title = `${I18n.t('Font')}: ${font === 'system-ui' ? I18n.t('System default') : font}`;
  }

  function openSizePanel(btn) {
    const rows = SIZES.map((s) =>
      `<button type="button" class="pop-row" data-size="${s.size}" style="font-size:${s.px}px">${esc(I18n.t(s.label))}</button>`).join('');
    const panel = openToolbarPanel(btn, `<div class="pop-list">${rows}</div>`);
    panel.querySelectorAll('[data-size]').forEach((b) => b.addEventListener('click', () => {
      closeToolbarPanel();
      exec('fontSize', b.dataset.size);
    }));
  }

  /** Text colour and highlight in one panel, the way Gmail's is: they are the
   *  same gesture asked about two different properties, and two separate
   *  toolbar buttons for it would cost a button nobody could tell apart. */
  function openColorPanel(btn) {
    const grid = (colors, kind) => colors.map((c) =>
      `<button type="button" class="pop-swatch" data-kind="${kind}" data-color="${escAttr(c)}"
        style="background:${escAttr(c)}" title="${escAttr(c)}"></button>`).join('');
    const panel = openToolbarPanel(btn, `
      <div class="pop-section">
        <div class="pop-label">${esc(I18n.t('Text colour'))}</div>
        <div class="pop-grid">${grid(TEXT_COLORS, 'fore')}</div>
      </div>
      <div class="pop-section">
        <div class="pop-label">${esc(I18n.t('Highlight'))}</div>
        <div class="pop-grid pop-grid-hilite">${grid(HILITE_COLORS, 'hilite')}</div>
        <button type="button" class="pop-row pop-clear" data-kind="none">${esc(I18n.t('No highlight'))}</button>
      </div>`);
    panel.querySelectorAll('[data-kind]').forEach((b) => b.addEventListener('click', () => {
      closeToolbarPanel();
      // 'transparent' rather than white: white is a colour, and a white
      // highlight is invisible on white and wrong on a dark-themed reader.
      if (b.dataset.kind === 'none') { exec('hiliteColor', 'transparent'); return; }
      const fore = b.dataset.kind === 'fore';
      exec(fore ? 'foreColor' : 'hiliteColor', b.dataset.color);
      // The bar under the button's A, so the toolbar shows what the next press
      // of it would apply — the way every other mail composer draws this.
      if (fore) btn.style.setProperty('--tb-fore', b.dataset.color);
    }));
  }

  /* ---------- emoji ---------- */

  function recentEmoji() {
    try { return JSON.parse(localStorage.getItem(EMOJI_RECENT_KEY) || '[]').filter((e) => typeof e === 'string'); }
    catch { return []; }
  }
  /** Most recent first, no duplicates, capped. Exported shape is a plain array
   *  of characters — see test/compose-toolbar-test.mjs. */
  function pushRecentEmoji(ch, list = recentEmoji()) {
    const next = [ch, ...list.filter((e) => e !== ch)].slice(0, EMOJI_RECENT_MAX);
    try { localStorage.setItem(EMOJI_RECENT_KEY, JSON.stringify(next)); } catch { /* private mode */ }
    return next;
  }

  /**
   * Inserts one emoji at the caret.
   *
   * Works in PLAIN text mode too, and that is deliberate: an emoji is a
   * character, not formatting, so it is the one control on this toolbar that
   * still means something with the rich editor switched off (see togglePlain,
   * which exempts this button from the blanket disable).
   */
  function insertEmoji(ch) {
    // The plain-text path belongs to the COMPOSER's textarea and to nothing
    // else. Without this check, picking an emoji while editing a signature —
    // with the composer left in plain mode behind it — wrote the character into
    // the message rather than the signature.
    const composerEditor = document.getElementById('c-editor');
    if (editorEl() === composerEditor && isPlain()) {
      const ta = document.getElementById('c-editor-plain');
      ta.focus();
      const at = ta.selectionStart ?? ta.value.length;
      ta.setRangeText(ch, at, ta.selectionEnd ?? at, 'end');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }
    withEditorSelection(() => document.execCommand('insertText', false, ch));
  }

  function openEmojiPanel(btn) {
    const recent = recentEmoji();
    const groups = [
      ...(recent.length ? [[I18n.t('Recent'), recent.join('')]] : []),
      ...EMOJI.map(([name, chars]) => [I18n.t(name), chars]),
    ];
    // [...str] rather than split(''): several of these are multi-code-unit
    // (and 😮‍💨 is three joined by ZWJ), and splitting on code units would
    // insert half a character.
    const cell = (ch) => `<button type="button" class="emoji-cell" data-emoji="${escAttr(ch)}">${esc(ch)}</button>`;
    const body = groups.map(([name, chars], i) =>
      `<div class="emoji-group" data-group="${i}">
        <div class="pop-label">${esc(name)}</div>
        <div class="emoji-grid">${[...chars].map(cell).join('')}</div>
      </div>`).join('');
    const tabs = groups.map(([name], i) =>
      `<button type="button" class="emoji-tab${i === 0 ? ' active' : ''}" data-tab="${i}">${esc(name)}</button>`).join('');
    const panel = openToolbarPanel(btn, `
      <div class="emoji-tabs">${tabs}</div>
      <div class="emoji-body">${body}</div>`);
    const bodyEl = panel.querySelector('.emoji-body');
    panel.querySelectorAll('.emoji-tab').forEach((t) => t.addEventListener('click', () => {
      panel.querySelectorAll('.emoji-tab').forEach((x) => x.classList.toggle('active', x === t));
      panel.querySelector(`.emoji-group[data-group="${t.dataset.tab}"]`)
        ?.scrollIntoView({ block: 'start', behavior: 'auto' });
    }));
    // The panel is the scroll container, so scrollIntoView above moves it —
    // stop that reaching the page behind on a phone.
    bodyEl.addEventListener('touchmove', (e) => e.stopPropagation(), { passive: true });
    panel.querySelectorAll('[data-emoji]').forEach((b) => b.addEventListener('click', () => {
      const ch = b.dataset.emoji;
      pushRecentEmoji(ch);
      // The panel stays open: picking emoji is usually picking several, and
      // reopening it four times to write one line is the thing that makes an
      // emoji picker annoying. The backdrop, Escape and the button all close it.
      insertEmoji(ch);
    }));
  }

  /* ---------- the ⋯ menu ----------
   * Everything used less often than the buttons that fit. A plain list menu
   * (openCtxMenu) rather than a panel: these are commands with names, and it
   * already clamps into the safe area and scrolls when it is taller than a
   * phone held in landscape.
   */
  function openMoreMenu(btn, menu = 'full') {
    const r = btn.getBoundingClientRect();
    const sigs = signaturesOf(currentIdentity());
    const items = [
      { label: '❝ Quote', onClick: () => formatBlockStyled('blockquote', QUOTE_STYLE) },
      { label: '⟨⟩ Code block', onClick: () => formatBlockStyled('pre', CODE_STYLE) },
      { label: '⇥ Increase indent', onClick: () => exec('indent') },
      { label: '⇤ Decrease indent', onClick: () => exec('outdent') },
      { label: '⬅ Align left', onClick: () => exec('justifyLeft') },
      { label: '↔ Align centre', onClick: () => exec('justifyCenter') },
      { label: '➡ Align right', onClick: () => exec('justifyRight') },
      { label: '─ Horizontal line', onClick: () => exec('insertHorizontalRule') },
      { label: '⌫ᴬ Clear formatting', onClick: () => exec('removeFormat') },
    ];
    // Both of these hide themselves when they have nothing to offer, the same
    // rule the template button already followed when it lived on the toolbar:
    // a menu entry that opens an empty menu is worse than no entry.
    // Only inside a real message. A template inserted into a template, or a
    // signature chosen for one, are both answers to questions Settings is not
    // asking — see wireRichEditor's `menu` option.
    if (menu === 'full') {
      if (templates.length) items.push({ label: '📋 Insert a template', onClick: () => showTemplateMenu(r.left, r.bottom + 4) });
      if (sigs.length > 1) items.push({ label: '✒ Signature', onClick: () => showSignatureMenu(r.left, r.bottom + 4) });
    }
    openCtxMenu(items, r.left, r.bottom + 4);
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
  /* Fields wired by attachRecipients({ groups: false }) — the calendar's
     attendee box. A group token is expanded server-side on the mail paths only
     (expandPayloadGroups, in /api/send and /api/drafts); an event save never
     passes through that, so a "👥 Team" left in an attendee list would be sent
     to the calendar server verbatim as an address that is not one. */
  const noGroupFields = new WeakSet();

  /**
   * Wires any text field as an address field: contact and group autocomplete,
   * the arrow/Enter/Tab handling that goes with the dropdown, and Backspace
   * taking a whole recipient at a boundary.
   *
   * Exported (Compose.attachRecipients) because the composer is not the only
   * place a list of addresses gets typed — the calendar's event editor has an
   * Attendees field, and asking people to type addresses in full there while
   * the composer completes them two clicks away is the kind of inconsistency
   * that reads as an oversight, because it was one.
   *
   * `groups:false` for anywhere that is not composing mail — see noGroupFields.
   * `grow:true` for the composer's own textareas, which size to their content.
   */
  function attachRecipients(inputEl, { groups = true, grow = false } = {}) {
    if (!inputEl) return;
    if (!groups) noGroupFields.add(inputEl);
    inputEl.addEventListener('focus', () => updateContactSuggestions(inputEl));
    inputEl.addEventListener('input', () => {
      if (grow) growRecipient(inputEl);
      updateContactSuggestions(inputEl);
    });
    inputEl.addEventListener('blur', () => closeContactSuggest());
    // Addresses copied out of another client arrive one per line very often,
    // and each line is a recipient rather than a line break.
    inputEl.addEventListener('paste', (e) => {
      const text = e.clipboardData?.getData('text');
      if (!text || !/[\r\n]/.test(text)) return;
      e.preventDefault();
      const flat = text.split(/[\r\n]+/).map((t) => t.trim()).filter(Boolean).join(', ');
      // execCommand keeps the browser's own undo stack intact, which setting
      // .value by hand would throw away.
      document.execCommand('insertText', false, flat);
      if (grow) growRecipient(inputEl);
    });
    // Arrow keys / Enter / Tab / Escape while the dropdown is open — see
    // onContactSuggestKeydown, which no-ops entirely when it isn't.
    inputEl.addEventListener('keydown', (e) => onContactSuggestKeydown(e, inputEl));
    // Backspace takes a whole recipient at a boundary, dropdown or no dropdown
    // — hence a listener of its own rather than another arm inside the one
    // above, which exists only for while the box is open.
    inputEl.addEventListener('keydown', (e) => onRecipientBackspace(e, inputEl));
    // LAST, so both handlers above see Enter first (the dropdown accepts a
    // completion with it). A textarea would otherwise take Enter literally, and
    // a newline inside an address list is not something any parser downstream
    // expects; in an <input> it simply did nothing, which is what this restores.
    inputEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') e.preventDefault(); });
  }

  function updateContactSuggestions(inputEl) {
    const value = inputEl.value;
    // recipientStart rather than a lastIndexOf pair, so this and the Backspace
    // handler above agree on where a recipient begins — and so a quoted display
    // name containing a comma stops being read as two half-recipients.
    const splitAt = recipientStart(value, value.length);
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
      // name/email kept apart as well as joined: the ROW needs them separate so
      // it can put the address on its own line when there is no width for both
      // (see paintContactSuggestRows), while `value` — what goes into the field
      // — stays the one canonical "Name <addr>" string it always was.
      return { label: full, name: name || '', email: email || '', value: prefix ? `${prefix} ${full}` : full, ...extra };
    };
    // Contact groups (server/contactGroups.js). Matched on the group's NAME —
    // it has no address of its own, and it is the name the server resolves at
    // send time. What goes into the field is the token, not the addresses: the
    // field stays readable, and the expansion happens once, on the server, so
    // the scheduled queue and every send backend only ever see real addresses.
    const groups = noGroupFields.has(inputEl) ? [] : (state.contactGroups || [])
      .filter((g) => String(g.name || '').toLowerCase().includes(typed))
      .slice(0, 10);
    const groupRow = (g) => {
      const token = `👥 ${g.name}`;
      const n = (g.members || []).length;
      // Translated as one whole string ("3 people"), not as a number glued to a
      // translated word — Slovenian does not inflect the noun the way English
      // does. See the `^(\d+) people$` regex in the language files.
      return {
        label: `${token} — ${I18n.t(n === 1 ? '1 person' : `${n} people`)}`,
        value: prefix ? `${prefix} ${token}` : token,
        // No `contact`, so Delete and the right-click menu both skip this row
        // on the guard they already have — a group is not removable from here.
        group: g,
      };
    };
    const options = [
      // Yours first: a small, fixed, high-signal set — CC'ing yourself is
      // common enough that it shouldn't be at the bottom of twenty contacts.
      ...own.map((o) => row(o.name, o.email, { own: true })),
      // Then groups: there are few of them, and one is worth more than any
      // single contact when it matches what is being typed.
      ...groups.map(groupRow),
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
      // Only meaningful to /api/send; saving a draft simply ignores it.
      followUpDays: followUpDays || undefined,
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
    // Whatever just happened here — saved, sent, discarded, scheduled — is what
    // decides whether the message being answered wears a ✎ in the list behind
    // this window (see server/draftLinks.js). One place rather than five,
    // because every one of those paths ends here.
    if (typeof syncDraftMarks === 'function') syncDraftMarks();
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
      // Guarded on the whole (account, folder, uid): discarding a draft must
      // not close some OTHER message the reader opened alongside it, and a uid
      // on its own names a different message in every other mailbox.
      if (typeof closeMessage === 'function'
          && isOpenMessage(acct?.id, acct?.draftsFolder || 'Drafts', draftUid)) closeMessage();
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
    // Emoji is exempt: it inserts a CHARACTER, not formatting, so it is the one
    // control here that still means something with the rich editor off (see
    // insertEmoji, which writes into the textarea in that mode). So is the
    // spell-check chip, which is about the words either editor holds.
    //
    // Matched on data-panel/id rather than on position: these buttons are built
    // by richToolbarHtml now, and a selector that depended on where they sit
    // would break the next time the bar is reordered.
    document.getElementById('editor-toolbar').querySelectorAll('button').forEach((b) => {
      if (b.dataset.panel !== 'emoji' && b.id !== 'c-lang') b.disabled = plain;
    });
    closeToolbarPanel();
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
    currentFont = font;
    // By class, not by id: the bar is built by richToolbarHtml now, and the
    // buttons carry no ids because the same markup is used three times.
    const btn = document.querySelector('#editor-toolbar .tb-font');
    if (btn) btn.title = `${I18n.t('Font')}: ${font === 'system-ui' ? I18n.t('System default') : font}`;
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

  /**
   * "This one has no subject." Asked after the attachment question, so a
   * message missing both does not open the second dialog before the user has
   * seen what the first one was about.
   *
   * Cancel focuses the subject field instead of only closing the dialog: the
   * answer to "did you forget it?" is nearly always yes, and the next thing
   * wanted is to type it. Whitespace is not a subject — "   " is what a stray
   * space bar leaves behind, not something anyone meant to send.
   *
   * Like the attachment guard, any failure inside means "go ahead": a broken
   * check must never be able to stop mail from being sent.
   */
  async function subjectCheck(p) {
    try {
      if (state.settings.subjectReminder === false) return true;
      if (String(p.subject || '').trim()) return true;
      const ok = !!await Dialog.confirm(
        I18n.t('This message has no subject. Send it anyway?'),
        { title: I18n.t('No subject'), okLabel: I18n.t('Send anyway') },
      );
      if (!ok) document.getElementById('c-subject')?.focus();
      return ok;
    } catch (e) {
      console.warn('Subject check failed:', e);
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
      noteFollowUpArmed(p);
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
    const toolbar = document.getElementById('editor-toolbar');
    // The buttons are BUILT, not written into index.html: Settings' signature
    // and template editors get the same ones from the same call, which is what
    // keeps the three toolbars from drifting apart.
    toolbar.querySelector('.tb-scroll').innerHTML = richToolbarHtml();
    wireRichEditor(toolbar, document.getElementById('c-editor'), {
      onChange: () => { dirty = true; },
      menu: 'full', // templates and the signature picker only mean something here
    });

    // Escape closes a picker without closing the composer — compose's own
    // document-level Escape handler would otherwise take the same keypress.
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || !panelEl) return;
      e.preventDefault();
      e.stopPropagation();
      closeToolbarPanel();
    }, true);

    document.getElementById('c-plain').addEventListener('change', (e) => togglePlain(e.target.checked));
    document.getElementById('btn-cc-toggle').addEventListener('click', () =>
      setCcVisible(document.querySelector('.cc-row').hidden));

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
    RECIPIENT_FIELDS.forEach((id) => {
      const inputEl = document.getElementById(id);
      attachRecipients(inputEl, { grow: true });
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
      if (!await subjectCheck(p)) return;
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
        noteFollowUpArmed(p);
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

    document.getElementById('c-priority').addEventListener('click', (e) => {
      const r = e.currentTarget.getBoundingClientRect();
      const current = e.currentTarget.value;
      openCtxMenu(PRIORITIES.map((p) => ({
        label: `${p.glyph}  ${I18n.t(p.label)}${p.value === current ? '  ✓' : ''}`,
        onClick: () => { setPriority(p.value); dirty = true; },
      })), r.left, r.bottom + 4);
    });

    document.getElementById('c-followup').addEventListener('click', (e) => {
      const r = e.currentTarget.getBoundingClientRect();
      openCtxMenu([
        { label: I18n.t('Remind me if nobody replies'), disabled: true },
        ...FOLLOW_UP_CHOICES.map(([d, label]) => ({
          label: `${I18n.t(label)}${d === followUpDays ? '  ✓' : ''}`,
          onClick: () => { setFollowUp(d); dirty = true; },
        })),
        { label: `${I18n.t('No reminder')}${followUpDays ? '' : '  ✓'}`, onClick: () => { setFollowUp(0); dirty = true; } },
      ], r.left, r.bottom + 4);
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
    document.getElementById('btn-compose-enlarge').addEventListener('click', () => {
      const large = el().classList.toggle('large');
      // Remembered for next time — but never from a phone, where `large` is
      // forced on by open() regardless and storing "small" from a stray tap
      // would be storing an answer that screen is never asked.
      if (isNarrow()) return;
      try { localStorage.setItem(COMPOSE_LARGE_KEY, large ? '1' : '0'); } catch { /* private mode */ }
    });
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

  return { init, open, reopen, reply, forward, editDraft, setIdentities, setTemplates, requestClose, isOpen, pickSendTime,
    attachRecipients,
    fonts: () => [...FONTS],
    // Settings' signature and template editors run on the same engine — see
    // richToolbarHtml/wireRichEditor above for why that is one call and not a
    // second copy of this toolbar.
    richToolbarHtml, wireRichEditor };
})();
