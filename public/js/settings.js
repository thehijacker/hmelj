// Hmelj — settings modal
const Settings = (() => {
  let tab = 'general';
  let draft = {}; // settings being edited
  let identities = [];
  let filters = [];
  let contacts = [];
  // Named sets of addresses (server/contactGroups.js), drafted like `contacts`
  // above: edited here, written on this tab's Save.
  let contactGroups = [];
  // Mirrors server/accounts.js's ACCOUNT_COLORS — the palette offered in the
  // wizard, and what the server would pick by round-robin if none is sent.
  const ACCOUNT_COLORS = ['#0b57d0', '#0f9d58', '#e37400', '#a142f4', '#d93025', '#00897b', '#f6bf26', '#5f6368'];
  const expandedIdentities = new Set(); // indices into `identities` currently showing their full field set

  const body = () => document.getElementById('settings-body');

  /* Which tab Settings was last on, so reopening it lands where you left off
   * instead of always on General — the tab you were in is usually the tab you
   * still care about (a run of filter edits, a folder cleanup, tuning the
   * scheduler). Device-local: this is transient UI position, not a preference
   * worth syncing to the server and pushing onto your other devices. */
  const TAB_KEY = 'hmelj-settings-tab';

  function rememberTab() {
    try { localStorage.setItem(TAB_KEY, tab); } catch { /* private mode / full quota — just don't remember */ }
  }

  /** The remembered tab, but only if it's still a real, reachable tab: a name
   * from an older build, or `admin` for someone who's since stopped being one
   * (its button is hidden — see setAdmin), both fall back to General rather
   * than opening an empty dialog. */
  function lastTab() {
    let saved = null;
    try { saved = localStorage.getItem(TAB_KEY); } catch { /* ignore */ }
    if (!saved) return 'general';
    const btn = document.querySelector(`#settings-tabs button[data-tab="${CSS.escape(saved)}"]`);
    return btn && !btn.hidden ? saved : 'general';
  }

  /** Switches tabs programmatically — same effect as clicking a nav button.
   * Used both by the nav buttons themselves and by in-tab shortcuts (the
   * Accounts tab's "Identities"/"Folders" buttons, and the "← Back to
   * Accounts" links on those two tabs). */
  function switchTab(name) {
    collectCurrentTab();
    tab = name;
    rememberTab();
    let activeBtn;
    document.querySelectorAll('#settings-tabs button').forEach((b) => {
      const active = b.dataset.tab === name;
      b.classList.toggle('active', active);
      if (active) activeBtn = b;
    });
    renderTab();
    // A new tab starts at its top. Without this the body keeps whatever offset
    // the previous tab was left at, so switching from the bottom of a long
    // Accounts list into General opened it halfway down. The two-level views
    // (account wizard, filter editor) restore their own saved position on the
    // way back and do not come through here.
    body().scrollTop = 0;
    // On mobile the tab strip scrolls horizontally (see app.css) — a switch
    // triggered from somewhere other than tapping the strip itself (the
    // Accounts tab's "Folders"/"Identities" shortcuts, a "← Back to
    // Accounts" link) could otherwise leave the newly-active tab scrolled
    // out of view with no visual sign anything changed. No-op wherever the
    // strip isn't actually scrollable (desktop's vertical list already
    // shows every tab at once).
    activeBtn?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  /**
   * One row of a settings grid: a label, its control, and — when there is
   * something to explain — a `?` beside the label that opens the explanation.
   *
   * The explanations used to sit under the control as a paragraph each. With
   * three or four settings on a tab that reads as helpful; with thirty it is a
   * wall of prose you have to scan past to find the switch you came for, and
   * the switches themselves stop being findable. They are one tap away now
   * instead of always on screen.
   *
   * I18n.t() on both, explicitly, and that is not optional: a hint used to be a
   * text node, which the language walker translates on its own (see i18n.js).
   * In an ATTRIBUTE it only ever looks at title/placeholder/aria-label — so
   * moving these without translating them here would have quietly reverted
   * every one of them to English for a Slovenian reader.
   */
  function field(label, inputHtml, hint = '') {
    return `<label>${label}${hint ? helpBadge(label, hint) : ''}</label><div>${inputHtml}</div>`;
  }

  /** The `?` itself. A real <button>, so it is reachable by keyboard and
   *  announced as one, rather than a span that only responds to a mouse. */
  function helpBadge(label, hint) {
    const title = String(label || '').replace(/<[^>]*>/g, '').trim();
    return `<button type="button" class="set-help" tabindex="0"
      data-help="${escAttr(I18n.t(hint))}" data-help-title="${escAttr(I18n.t(title))}"
      aria-label="${escAttr(`${I18n.t('What this setting does')}: ${I18n.t(title)}`)}"
      title="${escAttr(I18n.t('What this setting does'))}">?</button>`;
  }
  function sel(id, options, value) {
    return `<select id="${id}">` + options.map(([v, t]) => `<option value="${v}" ${v === value ? 'selected' : ''}>${t}</option>`).join('') + '</select>';
  }
  /** Shared by App font (General) and Message font (Reading) — the generic
   * keyword presets (see GENERIC_FONTS in app.js) plus any admin-uploaded
   * custom fonts (see state.customFonts) as their own optgroup underneath.
   * `value` is run through migrateFontValue() so a still-stored old
   * specific-name value (e.g. "Arial", from before this list changed) shows
   * up as its nearest generic replacement instead of silently matching
   * nothing and defaulting to the first option. */
  function fontSel(id, value) {
    const migrated = migrateFontValue(value);
    const generic = GENERIC_FONTS.map(([v, t]) => `<option value="${v}" ${v === migrated ? 'selected' : ''}>${I18n.t(t)}</option>`).join('');
    const custom = (state.customFonts || []);
    const customGroup = custom.length
      ? `<optgroup label="${escAttr(I18n.t('Custom'))}">${custom.map((f) =>
          `<option value="${escAttr(f.family)}" ${f.family === migrated ? 'selected' : ''}>${esc(f.family)}</option>`).join('')}</optgroup>`
      : '';
    return `<select id="${id}">${generic}${customGroup}</select>`;
  }
  /** The composer's own font list (Compose.fonts()), NOT fontSel above. Those two
   *  answer different questions: fontSel picks a generic keyword for rendering on
   *  THIS device, where a specific name can't be trusted to resolve; this one picks
   *  a face to name in outgoing mail, where a specific name is exactly what other
   *  clients expect. Each option previews itself in the face it names. */
  function composeFontSel(id, value) {
    const fonts = Compose.fonts();
    const current = fonts.includes(value) ? value : 'system-ui';
    return `<select id="${id}">` + fonts.map((f) =>
      `<option value="${escAttr(f)}" style="font-family:${escAttr(f === 'system-ui' ? 'system-ui' : `'${f}'`)}" ${f === current ? 'selected' : ''}>${f === 'system-ui' ? I18n.t('System default') : esc(f)}</option>`
    ).join('') + '</select>';
  }
  function chk(id, checked) { return `<input type="checkbox" id="${id}" ${checked ? 'checked' : ''}>`; }
  function txt(id, value, ph = '') { return `<input id="${id}" value="${escAttr(value ?? '')}" placeholder="${escAttr(ph)}">`; }
  function num(id, value, min = 0, max = 600) { return `<input id="${id}" type="number" min="${min}" max="${max}" value="${value}">`; }

  /** Populates the "Notification devices" list in the General tab —
   * separate async fetch from the rest of renderGeneral() (which is
   * synchronous, built straight from `draft`) since it needs a server
   * round-trip. Re-run after any change that could affect it (this
   * device's own checkbox, removing one from the list) so it never shows
   * stale state. No-op if the General tab (or this build without
   * Notification support) isn't currently showing the element. */
  async function refreshDeviceList() {
    const el = document.getElementById('s-notify-devices');
    if (!el) return;
    let list;
    try { list = await API.pushSubscriptions(); } catch { el.textContent = 'Could not load device list'; return; }
    if (!list.length) { el.textContent = 'No devices registered yet.'; return; }
    // Which of these rows is the machine you're looking at right now. Two
    // laptops running the same browser version produce two rows that read
    // identically, so without this there's no way to tell whether the one
    // you're on is even in the list.
    const mine = await currentPushDeviceId();
    el.innerHTML = list.map((s) => {
      const ua = s.ua || '';
      const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS'
        : /Windows/.test(ua) ? 'Windows' : /Mac OS/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : 'Device';
      // CodexaPush (the native Android app shell — no Service Worker Push
      // API in a WebView, see app.js's codexaPushSupported()) registers a
      // `{type:'fcm', token}` entry instead of a webpush `{endpoint, keys}`
      // one — labeled distinctly, and identified by its token for removal.
      const browser = s.type === 'fcm' ? 'Hmelj app' : /Firefox/.test(ua) ? 'Firefox' : /Edg\//.test(ua) ? 'Edge' : /Chrome/.test(ua) ? 'Chrome' : /Safari/.test(ua) ? 'Safari' : 'Browser';
      const id = s.type === 'fcm' ? s.token : s.endpoint;
      const when = s.createdAt ? new Date(s.createdAt).toLocaleString() : '';
      // In its OWN element, not appended to the date: i18n translates whole
      // text nodes (see public/js/i18n.js), so "12/08/2026, 09:58 — this
      // device" is one node that no catalog can ever match, while "this
      // device" on its own is a plain key like every other string here.
      const here = mine && id === mine ? ' — <span class="set-hint" style="margin:0">this device</span>' : '';
      return `<div class="dev-row" data-id="${escAttr(id)}" style="display:flex;align-items:center;gap:10px;padding:4px 0;">
        <span style="flex:1;min-width:0">${esc(browser)} / ${esc(os)} <span class="set-hint" style="margin:0">${esc(when)}</span>${here}</span>
        <button type="button" class="btn-sm danger dev-remove">Remove</button>
      </div>`;
    }).join('');
    // The Notifications checkbox above is ONE setting for the whole login, not
    // a per-device fact — so on a second laptop it reads as on while that
    // browser has never been registered (or has quietly lost its registration:
    // push services expire endpoints, browsers rotate them, and the server
    // prunes whatever comes back dead). That combination is invisible
    // otherwise, and is the usual explanation for "notifications work on one
    // of my machines and not the other".
    if (!mine || !list.some((s) => (s.type === 'fcm' ? s.token : s.endpoint) === mine)) {
      // One string, one text node — the whole sentence is the catalog key
      // (public/i18n/*.json), the same way the long field hints above are.
      el.insertAdjacentHTML('beforeend',
        `<div class="set-hint" style="margin:6px 0 0">The device you're using right now is not in this list, so it will not receive notifications. The checkbox above is one setting shared by all your devices, which is why it can still read as on here. Switch it off and on again to register this device.</div>`);
    }
    el.querySelectorAll('.dev-remove').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.closest('.dev-row').dataset.id;
        btn.disabled = true;
        try {
          await API.pushUnsubscribe(id);
          await detectPushActive(); // in case that was THIS device's own subscription — keeps the foreground-notifier fallback gate correct
          await refreshDeviceList();
          toast('Device removed');
        } catch (e) { toast('Remove failed: ' + e.message); btn.disabled = false; }
      });
    });
  }

  /* ---------- tabs ---------- */

  function renderGeneral() {
    const notifSupported = 'Notification' in window;
    const notifBlocked = notifSupported && Notification.permission === 'denied';
    // There is deliberately no Theme control here any more. It used to be a
    // plain dropdown between Language and App font, and it was the one setting
    // whose choice did nothing until Save was pressed — every other way of
    // changing the theme applies instantly. The user menu's Theme picker
    // (showThemePicker in app.js) owns it now: a live preview of each theme,
    // applied and persisted the moment one is picked, plus the custom
    // background/foreground colors this dropdown could never express. See
    // saveSettings for why the draft deliberately stops carrying it too.
    body().innerHTML = `<div class="set-grid">
      ${field('Language', sel('s-lang', I18n.languages, draft.language || 'en'))}
      ${field('App font', fontSel('s-uifont', draft.uiFont), 'Used everywhere in the app — the message reading pane has its own separate font setting below.')}
      ${field('App font size', num('s-uifontsize', draft.uiFontSize, 11, 24))}
      ${field('App font weight', sel('s-uiweight', [[400, 'Normal'], [700, 'Bold']], migrateUiWeight(draft.uiFontWeight)))}
      ${field('Keep the screen on', chk('s-keepawake', draft.keepScreenOn !== false), 'Stops the screen dimming and locking while Hmelj is open. This device only, like the font settings above — and only on a phone or tablet, where it means something.')}
      ${field('Time format', sel('s-time', [['24', '24-hour (14:30)'], ['12', '12-hour (2:30 PM)']], draft.timeFormat))}
      ${field('Date format', sel('s-date', [['DD.MM.YYYY', '31.12.2026'], ['MM/DD/YYYY', '12/31/2026'], ['YYYY-MM-DD', '2026-12-31'], ['D MMM YYYY', '31 Dec 2026']], draft.dateFormat))}
      <hr class="set-divider">
      ${field('Conversation view', chk('s-convview', draft.conversationView), 'Groups a message and its replies into one row, opened as the whole conversation with the newest message at the end. Needs the local cache; a search or an unread/starred filter always lists messages one by one.')}
      ${field('Expand every message in a conversation', chk('s-convexpand', draft.conversationExpandAll), 'Otherwise only the newest is opened and the rest are one-line headers you click. Each expanded message is its own fetch, so a long thread is slower to open.')}
      ${field('Messages per page', num('s-perpage', draft.messagesPerPage, 10, 200))}
      ${field('Messages kept per folder', num('s-backfill', draft.syncBackfillLimit, 50, 5000), 'How many of each folder\'s newest messages are cached locally for fast browsing. Lower is faster to sync; the rest is always still on the server and reachable via search.')}
      ${field('Messages kept ready to open instantly', num('s-contentcache', draft.contentCacheLimit, 0, 1000), 'How many of each folder\'s newest messages have their full content pre-fetched in the background, so opening them is instant instead of a live fetch. 0 turns this off — a message still gets cached the first time you open it, just not before. Cannot exceed "Messages kept per folder" above.')}
      ${field('Search box autocomplete', chk('s-searchauto', draft.searchAutocomplete), 'Finishes words as you type in the search box, suggested from your own mail history (sender names/addresses, subjects) — shown as selected text you can just keep typing over to ignore.')}
      ${field('Search index size limit', num('s-ftsmax', draft.searchIndexMaxMb, 0, 100000), 'A ceiling, in MB, on the full-text index that lets search look inside messages — turn it on per account under Mail accounts. 0 means no limit. This is a stop rather than a cleanup: at the ceiling nothing new is indexed until older mail ages out of the content cache above and takes its index entries with it, so searching keeps working, it just stops getting deeper. The index only ever covers messages the setting above has already cached, which is what bounds it in the first place.')}
      <hr class="set-divider">
      ${field('Run filters when opening Inbox', chk('s-runfilters', draft.runFiltersOnLoad))}
      ${field('Delete behavior', sel('s-delmode', [['trash', 'Move to Trash folder'], ['flag', 'Only mark as \\Deleted (keep in place)'], ['expunge', 'Delete permanently (expunge)']], draft.deleteBehavior))}
      ${field('Mark as read when deleting', chk('s-delread', draft.markReadOnDelete))}
      <hr class="set-divider">
      ${notifSupported
        ? field('Notifications', chk('s-notify', draft.desktopNotifications),
            notifBlocked ? 'Blocked by the browser — allow notifications for this site in its site settings, then re-enable here.'
              : pushSupported()
                ? 'Pops a system notification with sender + subject when new mail arrives — works even with Hmelj fully closed. On iPhone/iPad, tapping it opens straight to the message; on Android/desktop it also offers Mark as read/Delete right on the notification.'
                : 'Pops a system notification with sender + subject when new mail arrives, as long as Hmelj is open (a tab or the installed app) — it won\'t fire while fully closed. (Background delivery isn\'t supported in this browser.)')
        : field('Notifications', '<span class="set-hint" style="margin:0">Not supported in this browser</span>')}
      ${notifSupported
        ? field('', '<button type="button" id="s-notify-test" class="btn-sm">Send test notification</button>',
            'Pushes to every device you\'ve enabled notifications on right now — not just this one, so you can trigger it from any browser tab while watching your phone, without waiting for real mail to arrive. Not gated on this browser\'s own notification permission: it targets your other devices\' subscriptions, which don\'t depend on whether this tab has permission at all.')
        : ''}
      ${notifSupported
        ? field('Notification devices', '<div id="s-notify-devices" class="set-hint" style="margin:0">Loading…</div>',
            'Every device currently registered to receive push notifications for this account — enabling notifications on one device doesn\'t register any other, so a phone/desktop you\'re no longer using can be removed here without needing to log in from it.')
        : ''}
      <hr class="set-divider">
      ${field('Swipe gestures on mobile', chk('s-swipe', draft.swipeGestures), 'Swipe a message left or right to mark it read/unread or delete it — the action fires once you drag it about a third of the way across, and a swipe-delete can be taken back from the message that appears afterwards.')}
      ${field('Swipe direction', sel('s-swipedir', [['normal', 'Swipe left: read/unread · Swipe right: delete'], ['swapped', 'Swipe left: delete · Swipe right: read/unread']], draft.swipeSwapDirection ? 'swapped' : 'normal'))}
      <hr class="set-divider">
      ${field('Export your data',
        `<div class="row"><button class="btn-sm" id="s-export-settings">${I18n.t('Export settings')}</button>
         <button class="btn-sm" id="s-export-mail">${I18n.t('Export mail…')}</button></div>`,
        'Settings, identities, filters, subject rules, saved searches, templates, contacts and local calendars come out as one zip. Mail comes out separately, one folder at a time, as an mbox file — the format Thunderbird and every migration tool import. Your mail ACCOUNTS are deliberately not included: their passwords are encrypted with this server\'s own key, so a copy would be useless elsewhere, and decrypting them into the file would put every mailbox password in your downloads folder.')}
    </div>`;
    document.getElementById('s-export-settings')?.addEventListener('click', () => download(API.exportSettingsUrl()));
    document.getElementById('s-export-mail')?.addEventListener('click', exportMailDialog);
    document.getElementById('s-notify-test')?.addEventListener('click', async (e) => {
      e.target.disabled = true;
      try {
        const r = await API.pushTest();
        toast(r.deviceCount ? `Sent to ${r.deviceCount} device(s) — check the server log for per-device results` : 'No devices registered yet — enable notifications on this device first');
      } catch (err) {
        toast('Test failed: ' + err.message);
      } finally {
        e.target.disabled = false;
      }
    });
    document.getElementById('s-notify')?.addEventListener('change', async (e) => {
      if (!e.target.checked) { await disableNotifications(); return; }
      const ok = await enableNotifications();
      if (!ok) { e.target.checked = false; toast('Notifications permission was not granted'); }
      await refreshDeviceList(); // this device's own registration (or lack of it) just changed
    });
    refreshDeviceList();
    // Live preview — apply immediately (without touching state.settings, so
    // Cancel/close-without-save leaves nothing changed) so the readability
    // effect is visible right away, not just after Save.
    ['s-uifont', 's-uifontsize', 's-uiweight'].forEach((id) => {
      document.getElementById(id).addEventListener('change', () => {
        const root = document.documentElement.style;
        const font = document.getElementById('s-uifont').value;
        root.setProperty('--ui-font', fontFamilyCss(font));
        root.setProperty('--ui-scale', (+document.getElementById('s-uifontsize').value || 14) / 14);
        root.setProperty('--ui-weight', +document.getElementById('s-uiweight').value);
      });
    });
  }

  function renderReading() {
    body().innerHTML = `<div class="set-grid">
      ${field('Reading pane', sel('s-pane', [['right', 'Right side'], ['bottom', 'Bottom'], ['window', 'New window'], ['off', 'List only']], draft.readingPane))}
      ${field('Auto mark as read', sel('s-amr', [['immediate', 'Immediately on open'], ['delay', 'After a delay'], ['manual', 'Only via icon in list'], ['never', 'Never']], draft.autoMarkRead))}
      ${field('Mark-as-read delay (seconds)', num('s-amr-delay', draft.autoMarkReadDelay, 0, 120), 'Used when "After a delay" is selected.')}
      ${field('External images', sel('s-ext', [['always', 'Always load'], ['trusted', 'Only from trusted domains'], ['ask', 'Ask per message'], ['never', 'Never load']], draft.externalImages))}
      ${field('Trusted domains', `<textarea id="s-trusted" rows="3" style="width:100%">${esc((draft.trustedDomains || []).join('\n'))}</textarea>`, 'One domain per line, e.g. github.com')}
      ${field('Show deleted messages', chk('s-showdel', draft.showDeleted), 'Messages flagged \\Deleted appear struck through.')}
      ${field('Unsubscribe button', chk('s-unsub', draft.unsubscribeButton), 'Newsletters that say how to leave them (a List-Unsubscribe header) get a button in the reading pane. Nothing is ever sent without pressing it — but note that unsubscribing does tell the sender your address is read, which is not always what you want on mail you never asked for.')}
      ${field('Show whether the sender is verified', chk('s-authbadge', draft.senderAuthBadge !== false), 'Reads the SPF/DKIM/DMARC result your mail server recorded when the message arrived. A quiet mark beside the sender when the checks pass, and a warning when a message claims to come from a domain it is not allowed to send for, or wears the name of someone in your contacts over a different address. Messages where nothing was checked — which is normal on smaller mail servers — are left unmarked rather than treated as suspect.')}
      ${field('Compact unsubscribe banner', chk('s-unsub-min', draft.unsubscribeBannerCompact), 'Show that banner folded to just the icon and the button. Click the icon on a message to see where the request would go — the confirmation dialog names it either way.')}
      ${field('Message font', fontSel('s-font', draft.messageFont))}
      ${field('Message font size', num('s-fontsize', draft.messageFontSize, 11, 24))}
      ${field('Also use them for formatted mail', chk('s-fontforce', draft.messageFontOverride), 'Without this, the two settings above are only a fallback — and formatted mail almost never falls back to it, because it states its own fonts on the elements themselves. Turning this on makes your font win everywhere, and scales every size in the message by the same amount, so headings stay bigger than body text rather than everything becoming one size. The cost is that a newsletter designed around its own typeface stops looking the way its sender built it.')}
    </div>
    <div class="card" id="s-trusted-senders" style="margin-top:14px"></div>`;
    renderTrustedSenders();
  }

  /* ---------- senders the name check leaves alone ----------
   *
   * Added from the warning itself ("This sender is fine") or from an address's
   * right-click menu — this is where they can be looked at and taken back,
   * which is the part that keeps the feature from being a one-way door.
   *
   * Written straight to the server on each change rather than into the settings
   * draft: the list is its own file, the two places that ADD to it do the same,
   * and a Save button that had to be pressed afterwards would be a trap for
   * anyone who came here to undo one entry.
   */
  async function renderTrustedSenders() {
    const host = document.getElementById('s-trusted-senders');
    if (!host) return;
    if (trustedSenders === null) {
      trustedSenders = (await API.trustedSenders().catch(() => null))?.senders || [];
      if (!document.getElementById('s-trusted-senders')) return; // tab changed while loading
    }
    host.innerHTML = `<div class="set-section" style="margin-top:0">${esc(I18n.t('Senders whose name is never questioned'))}</div>
      <div class="set-hint" style="margin:0 0 8px">${esc(I18n.t('A ticketing system sends as the person who touched the ticket, over its own address — which looks exactly like an impersonation and is not one. Added from the warning on a message, or from an address\'s right-click menu. Only the name check is skipped; a failed SPF/DKIM/DMARC check still warns.'))}</div>
      ${trustedSenders.length
        ? trustedSenders.map((a) => `<div class="row" style="gap:8px;align-items:center">
            <span class="grow">${esc(a)}</span>
            <button class="link-btn ts-del" data-addr="${escAttr(a)}" title="${escAttr(I18n.t('Warn about this sender’s name again'))}">✕</button>
          </div>`).join('')
        : `<div class="set-hint" style="margin:0">${esc(I18n.t('None yet.'))}</div>`}`;
    host.querySelectorAll('.ts-del').forEach((b) => b.addEventListener('click', async () => {
      try {
        trustedSenders = (await API.untrustSender(b.dataset.addr)).senders || [];
        state.trustedSenders = trustedSenders;
        renderTrustedSenders();
      } catch (e) { toast(I18n.t('Could not save that') + ': ' + e.message, 6000); }
    }));
  }

  /* ---------- Offline ----------
   * Per DEVICE, not per login — see DEVICE_SETTINGS_KEYS in app.js. A phone and
   * a desktop sharing one Hmelj account have completely different answers to
   * "how much of my mail should live on this machine", and only one of them is
   * ever in someone's pocket.
   *
   * The panel leads with the figures rather than the switches: what this device
   * is actually holding, and how much room the browser is willing to give it.
   * Those are the two numbers that make the settings under them mean anything. */
  function renderOffline() {
    body().innerHTML = `<div class="set-grid">
      ${field('Keep mail available offline', chk('s-offline', draft.offlineEnabled !== false),
    'Saves the newest messages on this device so they can be read with no connection at all — including messages you have not opened yet. Anything you do while offline (read, star, delete, archive, or send) is queued in the Outbox and goes out as soon as the server is reachable again. Turning this off stops new mail being saved; press "Delete saved mail" below to remove what is already here.')}
      ${field('Messages kept per account', num('s-offline-count', draft.offlineMessages ?? 300, 0, 5000),
    'How many of the newest messages in each account are downloaded in full, in the background, so they can be opened offline. Older mail still appears in the list and still opens normally when there is a connection.')}
      ${field('Include attachments', chk('s-offline-att', !!draft.offlineAttachments),
    'Off by default, and the images inside a message are saved either way — this is about the files attached to it, which are usually the largest thing in a mailbox by a wide margin.')}
      ${field('Storage limit (MB)', num('s-offline-max', draft.offlineMaxMb ?? 250, 8, 20000),
    'The ceiling for saved mail on this device. When it is reached the oldest messages are dropped first, so what stays is always the newest — their list entries remain either way.')}
      <div class="set-section">On this device</div>
      <div class="offline-usage" id="offline-usage">${esc(I18n.t('Reading…'))}</div>
      <div class="offline-actions">
        <button class="btn-sm" id="btn-offline-now">Download now</button>
        <button class="btn-sm danger" id="btn-offline-clear">Delete saved mail</button>
      </div>
      <p class="offline-note">${esc(I18n.t('Saved mail is stored unencrypted in this browser’s own storage, like any other site’s data. On a shared or unencrypted device, leave this off — logging out deletes it.'))}</p>
    </div>`;
    refreshOfflineUsage();
    document.getElementById('btn-offline-now').addEventListener('click', async (e) => {
      if (!Connection.isOnline()) return toast(I18n.t('Not available while offline'));
      e.target.disabled = true;
      // collectCurrentTab first: pressing Download now with a larger number
      // typed but not yet saved should download that number, not the old one.
      collectCurrentTab();
      saveDeviceSettings({
        offlineEnabled: draft.offlineEnabled, offlineMessages: draft.offlineMessages,
        offlineAttachments: draft.offlineAttachments, offlineMaxMb: draft.offlineMaxMb,
      });
      toast(I18n.t('Saving mail for offline reading…'));
      const done = await Offline.prefetch({ force: true });
      e.target.disabled = false;
      // A pass that stopped early — the connection went, or the server was too
      // busy and the prefetcher stood down (see offline.js) — must not report
      // success. What it did manage is kept either way; the next pass resumes.
      toast(I18n.t(done ? 'Saved mail is up to date' : 'Stopped early — the server didn’t keep up. What was saved is kept.'), 6000);
      refreshOfflineUsage();
    });
    document.getElementById('btn-offline-clear').addEventListener('click', async () => {
      if (!await Dialog.confirm(
        I18n.t('Delete every message saved on this device for offline reading? Nothing is removed from the server.'),
        { title: I18n.t('Delete saved mail'), okLabel: I18n.t('Delete'), danger: true })) return;
      await Offline.wipe();
      // wipe() also clears the outbox, and a sidebar row counting a queue that
      // no longer exists would outlive it.
      await Outbox.init();
      toast(I18n.t('Saved mail deleted'));
      refreshOfflineUsage();
    });
  }

  /** The two figures the Offline panel leads with. Async and re-run rather than
   *  rendered once: a prefetch started from this very panel moves them while it
   *  is on screen. */
  async function refreshOfflineUsage() {
    const el = document.getElementById('offline-usage');
    if (!el) return;
    const u = await Offline.usage();
    const mb = (n) => (n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0) + ' MB';
    const lines = [
      // Two different counts on purpose, and the gap between them is the point:
      // an entry is a row in a message list (sender, subject, date — enough to
      // list and to search), a saved message is that plus the body, which is
      // what makes it readable offline. Every saved message has an entry; the
      // extra entries are messages this device knows about but did not download
      // — beyond the per-account limit, too new for the last pass, or dropped
      // to stay under the size cap.
      `${I18n.t('Messages saved in full')}: ${u.counts.bodies}`,
      `${I18n.t('Message list entries')}: ${u.counts.envelopes}`,
      `${I18n.t('Space used by saved mail')}: ≈ ${mb(u.bytes)}`,
    ];
    // The browser's own numbers, shown next to ours rather than instead of them,
    // because they answer a different question — they cover everything this site
    // stores (the app itself included) and report what is actually on disk,
    // which a browser that compresses its database (Firefox does) makes SMALLER
    // than our figure. Ours is an estimate of the content's own size, hence the
    // ≈ above; the two are not meant to agree.
    if (u.quota) lines.push(`${I18n.t('Space this browser allows')}: ${mb(u.used || 0)} / ${mb(u.quota)}`);
    if (u.counts.outbox) lines.push(`${I18n.t('Waiting in the Outbox')}: ${u.counts.outbox}`);
    el.innerHTML = lines.map((l) => `<div>${esc(l)}</div>`).join('');
  }

  /** A plain anchor navigation, never a Blob: an export can be gigabytes, and
   *  the Android shell's DownloadListener only sees a real navigation (it
   *  carries the session cookie, which JS cannot read to re-fetch with). */
  function download(url) {
    const a = document.createElement('a');
    a.href = url;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  /** Which account, which folder, and optionally from when. Asked rather than
   *  assumed: exporting is a deliberate act and the wrong folder is a long wait
   *  for the wrong file. */
  async function exportMailDialog() {
    const accts = allAccounts().filter((a) => !a.disabled);
    if (!accts.length) return toast(I18n.t('No mail accounts yet'));
    const first = accts[0].id;
    // loadFoldersFor fills the module-level `folderList` rather than returning
    // — same call the Folders tab makes.
    let folders = [];
    try { await loadFoldersFor(first); folders = folderList || []; } catch { folders = []; }
    const value = await Dialog.form(I18n.t('Export mail'),
      `<label class="dialog-label">${I18n.t('Account')}</label>
       ${sel('ex-acct', accts.map((a) => [a.id, a.label]), first)}
       <label class="dialog-label">${I18n.t('Folder')}</label>
       ${sel('ex-folder', (folders.length ? folders : [{ path: 'INBOX' }]).map((f) => [f.path, f.path]), 'INBOX')}
       <label class="dialog-label">${I18n.t('Only mail since (optional)')}</label>
       <input class="dialog-input" id="ex-since" type="date">
       <div class="set-hint">${I18n.t('One mbox file per folder. Large folders take a while and the browser cannot show progress — the download simply finishes when it finishes.')}</div>`,
      {
        okLabel: I18n.t('Export'),
        getValue: (r) => ({
          accountId: r.querySelector('#ex-acct').value,
          folder: r.querySelector('#ex-folder').value,
          since: r.querySelector('#ex-since').value,
        }),
        onOpen: (r) => {
          // The folder list belongs to the chosen account, so it is re-read
          // when that changes — otherwise picking a second account offers the
          // first one's folders, and the export quietly 404s or exports nothing.
          r.querySelector('#ex-acct').addEventListener('change', async (e) => {
            const sel2 = r.querySelector('#ex-folder');
            sel2.innerHTML = `<option>${I18n.t('Loading…')}</option>`;
            let list = [];
            try { await loadFoldersFor(e.target.value); list = folderList || []; } catch { list = []; }
            sel2.innerHTML = (list.length ? list : [{ path: 'INBOX' }])
              .map((f) => `<option value="${escAttr(f.path)}">${esc(f.path)}</option>`).join('');
          });
        },
      });
    if (!value?.folder) return;
    download(API.exportMailUrl(value.folder, value.accountId, value.since));
    toast(I18n.t('Export started — the file appears when the whole folder has been read.'), 6000);
  }

  function renderCompose() {
    body().innerHTML = `<div class="set-grid">
      ${field('Default format', sel('s-format', [['html', 'HTML (rich text)'], ['plain', 'Plain text']], draft.composeFormat))}
      ${field('Default font', composeFontSel('s-compose-font', draft.composeFont), 'Used for what you write in new messages, replies and forwards — not for the quoted original. Rich text only. The toolbar\'s font button still overrides it per message.')}
      ${field('Quoted message on reply', sel('s-quote', [['below', 'Below my reply'], ['above', 'Above my reply'], ['none', 'Do not quote']], draft.replyQuotePosition))}
      ${field('Autosave drafts every (seconds)', num('s-autosave', draft.autosaveDraftSeconds, 0, 600), '0 disables autosave.')}
      ${field('Undo send window (seconds)', num('s-undosend', draft.undoSendSeconds, 0, 120), 'How long Send holds a message back so you can take it out of the outbox again — a toast offers Undo for that long. 0 sends immediately. The wait is on the server, not in this tab, so the window still applies if you close Hmelj right after pressing Send; the message simply goes out when the time is up.')}
      ${field('Request read receipts by default', chk('s-receipt', draft.requestReadReceipt))}
      ${field('Warn about a missing attachment', chk('s-attachwarn', draft.attachmentReminder !== false), 'Before sending, checks whether what you wrote mentions an attachment while nothing is attached — in English and Slovenian, including forms written without šumniki. Only your own text is read: the quoted original and your signature are ignored, so replying to someone who wrote \'v prilogi\' does not ask.')}
      ${field('Warn about a missing subject', chk('s-subjectwarn', draft.subjectReminder !== false), 'Before sending, asks when the subject line is empty. Cancel puts the cursor in the subject field; Send anyway sends it as it is.')}
      ${field('Offer Reply to all', chk('s-replyall', draft.replyAllNudge !== false), 'When you press Reply on a message that had other people on it, offer to reply to all of them instead. A message addressed only to you never asks.')}
      ${field('Check spelling as I type', chk('s-spellcheck', draft.spellcheck !== false), 'Slovenian and English, detected automatically. Spelling only — no grammar. Off uses your browser\'s own spellchecker instead.')}
    </div>`;
  }

  /* ---------- mail accounts ---------- */

  let accountsView = 'list'; // 'list' | 'wizard'
  let wizardTarget = null; // account being edited, or null when adding
  // Captured on Edit, restored once back on the list (Cancel/Back, or a successful
  // Test & save) — renderAccountsList() rebuilds #settings-body's innerHTML from
  // scratch every time, which drops any scroll position the browser doesn't restore on
  // its own; without this, returning from editing an account further down a long list
  // lands back at the very top (or, if the wizard form was taller than the list, gets
  // clamped to the very bottom of the now-shorter content instead — the bug reported).
  let accountsListScrollTop = 0;
  let wizardPresets = [];
  // OAuth providers this server can actually sign in with (server/oauth.js),
  // and the sign-in the wizard has completed so far. `state` is the one-time
  // handle the server uses to find the tokens it is holding — it is NOT a
  // token itself, and there is deliberately no way for this code to see one.
  let oauthProviders = [];
  // Full-text index figures per owned account (GET /api/search-index), fetched
  // once per Settings session and re-read after a toggle. null = not fetched
  // yet or the request failed; searchIndexRow() copes with both.
  let searchIndexInfo = null;
  // Sidebar-pinned searches, edited as a list on their own tab. Like filters:
  // loaded on open, written by Save, and adopted back from the server's own
  // normalised response rather than from what was sent.
  let savedSearches = [];
  // Message boilerplate (Settings > Templates), loaded on open and written by Save.
  let templates = [];
  let wizardOAuth = { provider: '', state: '', email: '' };
  // "Use an app password instead" pressed while editing an account that signs
  // in: turns the open form back into a plain IMAP one for this save only (the
  // account keeps its id — see server/accounts.js's `oauth: null` handling).
  let wizardRevert = false;
  let accountStatuses = {}; // accountId -> {lastSyncedAt, syncing, lastError} — from /api/sync/status
  let statusPollTimer = null;
  // Resolved by the inline wizard (save -> the account, cancel/back -> null)
  // only when Settings.accountWizard() (below) is the one driving it — i.e.
  // the first-run "you have zero accounts, add one" bootstrap in app.js.
  // Null the rest of the time, when the wizard was opened by clicking
  // Add/Edit from an already-open Accounts tab.
  let wizardDoneResolver = null;

  function fmtRelativeTime(ms) {
    const diff = Date.now() - ms;
    if (diff < 60e3) return I18n.t('just now');
    const mins = Math.round(diff / 60e3);
    if (mins < 60) return `${mins}m ${I18n.t('ago')}`;
    const hrs = Math.round(mins / 60);
    if (hrs < 24) return `${hrs}h ${I18n.t('ago')}`;
    return `${Math.round(hrs / 24)}d ${I18n.t('ago')}`;
  }

  /** Connection dot (reuses the header's .conn/.conn.ok convention) + last-sync
   * text, derived from /api/sync/status — the background poller is what's
   * actually continuously exercising each account's IMAP connection, so its
   * last-known state is a more meaningful "connected" signal than a one-off
   * ping would be, and it's already there for free. */
  function accountStatusHtml(accountId) {
    const s = accountStatuses[accountId];
    if (!s) return `<span class="set-hint" style="margin:0">…</span>`;
    if (s.syncing) return `<span class="conn ok">●</span><span class="set-hint" style="margin:0">${I18n.t('Syncing…')}</span>`;
    if (s.lastError) return `<span class="conn" title="${escAttr(s.lastError)}">●</span><span class="set-hint" style="margin:0;color:var(--danger)">${esc(s.lastError)}</span>`;
    if (!s.lastSyncedAt) return `<span class="set-hint" style="margin:0">${I18n.t('Not synced yet')}</span>`;
    // An account set to Live says whether it actually IS. Without this the row
    // read "Connected · synced 3m ago" whether the watcher was up or had been
    // retrying with backoff for an hour — that timestamp comes from the
    // fallback poll either way, so it cannot answer the question.
    const live = s.monitorMode === 'idle'
      ? (s.live
        ? ` · <span title="${escAttr(I18n.t('A live connection to the server is open; new mail arrives without waiting for the next check.'))}">${esc(I18n.t('live'))}</span>`
        : ` · <span style="color:var(--danger)" title="${escAttr(I18n.t('Live monitoring is set for this account but is not connected right now — it retries in the background, and the regular check still covers it.'))}">${esc(I18n.t('live: reconnecting'))}</span>`)
      : '';
    return `<span class="conn ok">●</span><span class="set-hint" style="margin:0">${I18n.t('Connected')} · ${I18n.t('synced')} ${fmtRelativeTime(s.lastSyncedAt)}${live}</span>`;
  }

  async function refreshAccountStatuses() {
    try {
      accountStatuses = Object.fromEntries((await API.syncStatus()).map((s) => [s.accountId, s]));
    } catch { return; }
    for (const a of state.accounts) {
      const el = body().querySelector(`.ac-status[data-status-for="${a.id}"]`);
      if (el) el.innerHTML = accountStatusHtml(a.id);
    }
  }

  function accountCard(a) {
    const serverLabel = a.type === 'graph' ? 'Microsoft Graph' : (a.type === 'ews' ? a.ews.url : a.imap.host);
    // Microsoft keeps its sign-in in `graph`, a Gmail/XOAUTH2 IMAP account in
    // `oauth` (see server/accounts.js) — everything below is identical for both.
    const signIn = a.graph || a.oauth;
    // A shared-in account (someone else's, shared to us)
    // never shows credentials/server-setting controls at all: no Edit, no
    // Folders (special-folder mapping is owner-only; a grantee's own hidden
    // folders are personalization and live in server/accountOverrides.js
    // instead), no Disable, and Remove becomes Leave (removes
    // just this viewer's own access, not the account itself — the owner
    // never sees this button, only ac-del).
    const isOwner = !a.shared;
    const sharedBadge = a.shared ? `<span class="set-hint" style="margin:0">🔗 ${I18n.t('Shared by')} ${esc(a.ownerUsername)}</span>` : '';
    const grantees = isOwner && (a.sharedWith || []).length
      ? `<div class="row" style="flex-wrap:wrap;gap:6px 4px;">
          <span class="set-hint" style="margin:0">${I18n.t('Shared with')}:</span>
          ${a.sharedWith.map((s) => `<span class="attach-chip">${esc(s.username)} <button data-uid="${escAttr(s.userId || s.id)}" class="ac-unshare" title="${I18n.t('Remove access')}">✕</button></span>`).join('')}
        </div>`
      : '';
    // A signed-in account's stored credential expires and can be revoked from
    // the provider's side, which a password never does — so it needs a visible
    // "this has stopped working, sign in again" state that the rest of the
    // card has no equivalent for.
    const providerName = { microsoft: 'Microsoft', google: 'Google' };
    const oauthBadge = signIn
      ? (signIn.needsReauth
        ? `<div class="row"><span class="set-hint wiz-status err" style="margin:0">⚠️ ${I18n.t('Sign-in expired — this account cannot fetch mail until you sign in again.')}</span>
             <span class="spacer"></span><button class="btn-sm ac-reauth">${I18n.t('Sign in again')}</button></div>`
        : `<div class="row"><span class="set-hint" style="margin:0">🔑 ${I18n.t('Signed in with')} ${esc(providerName[signIn.provider] || signIn.provider)}${signIn.signedInAs ? ' · ' + esc(signIn.signedInAs) : ''}</span></div>`)
      : '';
    // A password IMAP account that COULD sign in instead, because it already
    // points at a provider Hmelj can sign in to (today: Gmail). The switch
    // happens in place — same account id, so the message cache, analytics index,
    // identities, filters and folder settings all survive it, which is the whole
    // reason this is a button here rather than "remove and add again".
    const switchable = isOwner && !signIn && (a.type || 'imap') === 'imap'
      ? oauthProviders.find((p) => p.kind === 'imap' && p.configured && p.attachHostPattern
        && new RegExp(p.attachHostPattern, 'i').test(a.imap?.host || ''))
      : null;
    const switchRow = switchable
      ? `<div class="row"><span class="set-hint" style="margin:0">🔑 ${I18n.t('Signs in with a stored app password.')}</span>
           <span class="spacer"></span><button class="btn-sm ac-switch-oauth" data-provider="${escAttr(switchable.id)}">${I18n.t('Switch to signing in')}</button></div>`
      : '';
    return `<div class="card${a.disabled ? ' ac-disabled' : ''}" data-acct="${a.id}">
      <div class="row">
        <span class="acct-dot" style="background:${escAttr(a.color)}"></span>
        <b>${esc(a.label)}</b>
        <span class="set-hint" style="margin:0">${esc(a.email)} · ${esc(serverLabel)}</span>
        <span class="spacer"></span>
        ${sharedBadge}
        ${a.disabled ? '<span class="set-hint" style="margin:0;color:var(--danger)">disabled</span>'
          : `<span class="ac-status" data-status-for="${a.id}">${accountStatusHtml(a.id)}</span>`}
      </div>
      <div class="row">
        ${isOwner ? `<button class="btn-sm ac-edit">${I18n.t('Edit')}</button>` : ''}
        <button class="btn-sm ac-identities">${I18n.t('Identities')}</button>
        <button class="btn-sm ac-folders">${I18n.t('Folders')}</button>
        <span class="spacer"></span>
        ${isOwner ? `<button class="btn-sm ac-share">${I18n.t('Share')}</button>` : ''}
        ${isOwner ? `<button class="btn-sm ac-toggle">${a.disabled ? I18n.t('Enable') : I18n.t('Disable')}</button>` : ''}
        <button class="btn-sm danger ${isOwner ? 'ac-del' : 'ac-leave'}">${isOwner ? I18n.t('Remove') : I18n.t('Leave')}</button>
      </div>
      ${isOwner ? oauthBadge : ''}
      ${isOwner ? switchRow : ''}
      ${isOwner ? searchIndexRow(a) : ''}
      ${grantees}
    </div>`;
  }

  /** Human-readable byte size for the index figures. */
  function mb(bytes) {
    if (!bytes) return '0 MB';
    const m = bytes / 1024 / 1024;
    return m < 0.1 ? '<0.1 MB' : `${m.toFixed(m < 10 ? 1 : 0)} MB`;
  }

  /**
   * "Search inside messages" — the per-account full-text index
   * (server/cache.js#message_fts). Owner-only, and its own row rather than a
   * line in the wizard, because it is the one account setting whose cost a
   * person needs to SEE while deciding: the numbers next to it are the answer
   * to "what will this do to my disk?", which is why it reports size at all.
   *
   * `searchIndexInfo` is fetched once per Settings session; while it is still
   * loading (or if the cache is off entirely) the row degrades to the toggle
   * without figures rather than not appearing.
   */
  function searchIndexRow(a) {
    if (searchIndexInfo && !searchIndexInfo.enabled) return '';
    const info = searchIndexInfo?.accounts?.[a.id];
    const on = info ? info.on : !!a.searchIndex;
    let detail = '';
    if (info && on) {
      const parts = [I18n.t('{n} messages indexed').replace('{n}', info.messages)];
      if (info.share) parts.push('≈' + mb(info.share));
      // Only worth mentioning while there is a backlog — steady state is 0 and
      // saying "0 waiting" every time reads as a problem rather than as idle.
      if (info.pending) parts.push(I18n.t('{n} waiting').replace('{n}', info.pending));
      detail = ' · ' + parts.join(' · ');
    }
    const full = searchIndexInfo && searchIndexInfo.maxMb > 0 && searchIndexInfo.bytes > searchIndexInfo.maxMb * 1024 * 1024;
    return `<div class="row">
      <span class="set-hint" style="margin:0">🔍 ${I18n.t('Search inside messages')}${esc(detail)}</span>
      ${full && on ? `<span class="set-hint wiz-status err" style="margin:0">${I18n.t('Size limit reached — pausing until older mail ages out')}</span>` : ''}
      <span class="spacer"></span>
      <button class="btn-sm ac-index">${on ? I18n.t('Turn off') : I18n.t('Turn on')}</button>
    </div>`;
  }

  function renderAccountsTab() {
    return accountsView === 'wizard' ? renderAccountWizard() : renderAccountsList();
  }

  async function renderAccountsList() {
    // Needed by accountCard() to decide whether a password account could sign in
    // instead. Fetched once per Settings session and cached in the module — the
    // answer only changes when an admin configures a provider. Failure is not
    // fatal: the "switch to signing in" row simply doesn't appear.
    if (!oauthProviders.length) oauthProviders = await API.oauthProviders().catch(() => []);
    // Same "fetch once per Settings session" treatment as oauthProviders, and
    // failure is equally non-fatal: searchIndexRow() falls back to a bare
    // toggle. Re-read after a toggle so the figures move without a reload.
    if (!searchIndexInfo) searchIndexInfo = await API.searchIndex().catch(() => null);
    body().innerHTML = `<div class="card-list">
      ${allAccounts().map(accountCard).join('')}
      </div>
      <p><button class="link-btn" id="ac-add">+ Add mail account</button></p>
      <p class="set-hint">Passwords are stored encrypted on the server (AES-256-GCM). Disabling an account keeps it configured but pauses background sync and hides it from the sidebar and All inboxes — handy if a provider is temporarily misbehaving, without losing the setup. Unlike the rest of Settings, account changes here (add, edit, enable/disable, remove) save immediately — they don't wait for the Save button below.</p>`;
    document.getElementById('ac-add').addEventListener('click', () => {
      wizardTarget = null;
      // Record it here too, not just on .ac-edit below: without this, going
      // back from Add restored whatever position the last Edit had saved.
      accountsListScrollTop = body().scrollTop;
      accountsView = 'wizard';
      renderAccountsTab();
    });
    body().querySelectorAll('.ac-edit').forEach((b) => b.addEventListener('click', () => {
      const id = b.closest('[data-acct]').dataset.acct;
      wizardTarget = state.accounts.find((a) => a.id === id);
      accountsListScrollTop = body().scrollTop;
      accountsView = 'wizard';
      renderAccountsTab();
    }));
    // Re-sign-in for an account whose refresh token died (revoked consent,
    // password change, or simply aged out — and for Google, a consent screen
    // left in "Testing", which expires them every 7 days). Same flow as the
    // wizard's sign-in button, but it attaches the result to the account that
    // already exists instead of building a new one.
    body().querySelectorAll('.ac-reauth').forEach((b) => b.addEventListener('click', async () => {
      const id = b.closest('[data-acct]').dataset.acct;
      const a = state.accounts.find((x) => x.id === id);
      b.disabled = true;
      try {
        const r = await OAuthFlow.signIn({ provider: (a.graph || a.oauth).provider, email: a.email, accountId: id });
        await API.oauthAttach(r.state, id);
        toast(I18n.t('Signed in again') + ' ✓');
        await reloadAccounts();
      } catch (err) {
        toast(err.message);
      } finally {
        b.disabled = false;
      }
    }));
    // Migrate a password account onto a sign-in, in place. Deliberately the same
    // endpoint as re-auth above: the server keeps the account id and everything
    // keyed to it (cache, analytics index, identities, filters, folder settings,
    // shares) and only swaps the credential.
    body().querySelectorAll('.ac-switch-oauth').forEach((b) => b.addEventListener('click', async () => {
      const id = b.closest('[data-acct]').dataset.acct;
      const a = state.accounts.find((x) => x.id === id);
      const provider = b.dataset.provider;
      const label = oauthProviders.find((p) => p.id === provider)?.label || provider;
      const go = await Dialog.confirm(
        `${I18n.t('This account will stop using its stored app password and sign in with')} ${label} ${I18n.t('instead. Nothing else changes — same mailbox, same folders, same cached mail, same settings. You can switch back to a password at any time by editing the account.')}`,
        { title: I18n.t('Switch to signing in?'), okLabel: I18n.t('Sign in') }
      );
      if (!go) return;
      b.disabled = true;
      try {
        const r = await OAuthFlow.signIn({ provider, email: a.email, accountId: id });
        await API.oauthAttach(r.state, id);
        toast(I18n.t('Now signing in instead of using a password') + ' ✓');
        await reloadAccounts();
      } catch (err) {
        toast(err.message, 8000);
      } finally {
        b.disabled = false;
      }
    }));
    body().querySelectorAll('.ac-identities').forEach((b) => b.addEventListener('click', () => {
      const id = b.closest('[data-acct]').dataset.acct;
      identities.forEach((idy, i) => { if (idy.accountId === id) expandedIdentities.add(i); });
      switchTab('identities');
      document.getElementById(`idgrp-${id}`)?.scrollIntoView({ block: 'start' });
    }));
    body().querySelectorAll('.ac-folders').forEach((b) => b.addEventListener('click', () => {
      foldersAccountId = b.closest('[data-acct]').dataset.acct;
      switchTab('folders');
    }));
    body().querySelectorAll('.ac-toggle').forEach((b) => b.addEventListener('click', async () => {
      const id = b.closest('[data-acct]').dataset.acct;
      const a = state.accounts.find((x) => x.id === id);
      await API.patchAccount(id, { disabled: !a.disabled });
      await reloadAccounts();
    }));
    body().querySelectorAll('.ac-index').forEach((b) => b.addEventListener('click', async () => {
      const id = b.closest('[data-acct]').dataset.acct;
      const on = !!(searchIndexInfo?.accounts?.[id]?.on ?? state.accounts.find((x) => x.id === id)?.searchIndex);
      // Turning it OFF throws away work and disk, so it asks first; turning it
      // on costs nothing that isn't already on disk and is silently reversible.
      if (on && !await Dialog.confirm(
        I18n.t('Stop searching inside this account\'s messages? The index is deleted; your mail and its cached content are untouched.'),
        { title: I18n.t('Search inside messages'), okLabel: I18n.t('Turn off') },
      )) return;
      b.disabled = true;
      try {
        await API.patchAccount(id, { searchIndex: !on });
        searchIndexInfo = await API.searchIndex().catch(() => null);
        await reloadAccounts();
        if (!on) toast(I18n.t('Indexing started — searching inside messages will get more complete over the next few minutes.'));
      } catch (e) {
        toast(I18n.t('Could not change that') + ': ' + e.message, 6000);
        b.disabled = false;
      }
    }));
    body().querySelectorAll('.ac-del').forEach((b) => b.addEventListener('click', async () => {
      const id = b.closest('[data-acct]').dataset.acct;
      const a = state.accounts.find((x) => x.id === id);
      if (!await Dialog.confirm(I18n.t('Remove mail account') + ` "${a.label}"?`, { title: I18n.t('Remove mail account'), okLabel: I18n.t('Remove') })) return;
      await API.deleteAccount(id);
      // drop identities bound to this account
      state.identities = await API.saveIdentities(state.identities.filter((i) => i.accountId !== id));
      await reloadAccounts();
    }));
    body().querySelectorAll('.ac-share').forEach((b) => b.addEventListener('click', async () => {
      const id = b.closest('[data-acct]').dataset.acct;
      const username = await Dialog.prompt(I18n.t('Share with which Hmelj user?'), { label: I18n.t('Username:'), placeholder: 'username' });
      if (!username) return;
      try {
        await API.shareAccount(id, username.trim());
        await reloadAccounts();
        toast(I18n.t('Shared'));
      } catch (e) { toast(I18n.t('Could not share: ') + e.message); }
    }));
    body().querySelectorAll('.ac-unshare').forEach((b) => b.addEventListener('click', async () => {
      const id = b.closest('[data-acct]').dataset.acct;
      const userId = b.dataset.uid;
      if (!await Dialog.confirm(I18n.t('Remove this person\'s access to the account?'), { title: I18n.t('Remove access'), okLabel: I18n.t('Remove') })) return;
      await API.unshareAccount(id, userId);
      await reloadAccounts();
    }));
    body().querySelectorAll('.ac-leave').forEach((b) => b.addEventListener('click', async () => {
      const id = b.closest('[data-acct]').dataset.acct;
      const a = state.accounts.find((x) => x.id === id);
      if (!await Dialog.confirm(I18n.t('Leave this shared account') + ` "${a.label}"? ` + I18n.t('You\'ll lose access until it\'s shared with you again.'), { title: I18n.t('Leave'), okLabel: I18n.t('Leave'), danger: true })) return;
      await API.leaveAccount(id);
      // drop this viewer's own identities bound to it — dangling otherwise, since access is gone
      state.identities = await API.saveIdentities(state.identities.filter((i) => i.accountId !== id));
      await reloadAccounts();
    }));
    refreshAccountStatuses();
    clearInterval(statusPollTimer);
    statusPollTimer = setInterval(refreshAccountStatuses, 15000);
  }

  async function reloadAccounts() {
    state.accounts = await API.accounts();
    renderAccountsTab();
    renderAccounts();
    // Switch away if the account being viewed was deleted, OR just disabled
    // (it's about to disappear from the sidebar either way).
    const stillActive = state.accounts.some((a) => a.id === state.currentAccount && !a.disabled);
    if (!stillActive && state.currentAccount !== 'all') {
      const active = activeAccounts();
      switchAccount(active.length ? active[0].id : 'all');
    }
  }

  /**
   * Add / edit mail account, rendered inline in the Accounts tab (not a
   * stacked dialog) so "← Back to accounts" and in-place error feedback on a
   * failed test both work naturally — see submitWizard.
   */
  async function renderAccountWizard() {
    const e = wizardTarget;
    // One round trip, not two — both lists are needed before the first paint.
    [wizardPresets, oauthProviders] = await Promise.all([
      API.presets().catch(() => []),
      API.oauthProviders().catch(() => []),
    ]);
    const v = (x, d = '') => escAttr(x ?? d);
    const sameServer = e ? !!e.smtp?.sameServer : true;
    const sameCreds = e ? !!e.smtp?.sameCredentials : true;
    // Same default the server itself would pick on save if none is sent —
    // keeps the picker's initial selection consistent with reality.
    const defaultColor = e?.color || ACCOUNT_COLORS[state.accounts.length % ACCOUNT_COLORS.length];
    // An account's type is fixed at creation — the field sets share nothing
    // worth trying to carry over, so editing shows it as a plain label rather
    // than a switchable control.
    //
    // 'gmail' is a wizard-only pseudo-type: the server stores it as an ordinary
    // type:'imap' account whose credential is an `oauth` block instead of a
    // password (see submitWizard and server/oauth.js). So it's recognised on
    // edit by that block being present, not by a stored type of its own.
    const type = e ? (e.oauth ? 'gmail' : e.type || 'imap') : 'imap';
    const providersOfKind = (kind) => oauthProviders.filter((p) => p.kind === kind);
    // Which OAuth provider the two sign-in types default to — the account's own
    // if we're editing, otherwise the first configured one of the right kind.
    const defaultProvider = (kind) =>
      providersOfKind(kind).find((p) => p.configured)?.id || providersOfKind(kind)[0]?.id || '';
    wizardOAuth = {
      provider: e?.oauth?.provider || e?.graph?.provider || defaultProvider(type === 'gmail' ? 'imap' : 'graph'),
      state: '',
      email: e?.oauth?.signedInAs || e?.graph?.signedInAs || '',
    };
    wizardRevert = false;
    const typeLabel = {
      ews: I18n.t('Exchange (EWS)'),
      graph: I18n.t('Microsoft (Outlook / Microsoft 365)'),
      gmail: I18n.t('Gmail (sign in with Google)'),
      imap: I18n.t('IMAP + SMTP'),
    };
    // One control for two stored fields (see accounts.js): 'idle' selects live
    // monitoring, any other value is a poll interval in ms. New accounts
    // default to the server-wide interval, i.e. exactly today's behavior.
    const monitorValue = e?.monitorMode === 'idle' ? 'idle' : String(e?.pollIntervalMs || 120000);

    body().innerHTML = `
      <p><button class="link-btn" id="w-back">← ${I18n.t('Back to accounts')}</button></p>
      <h3 style="margin:2px 0 12px">${I18n.t(e ? 'Edit mail account' : 'Add mail account')}</h3>
      <div class="wiz-grid">
        <div class="full"><label>${I18n.t('Account type')}</label>
          ${e ? `<div class="set-hint" id="w-type-label" style="margin:4px 0 0">${typeLabel[type]}</div>`
              : sel('w-type', [['imap', I18n.t('IMAP + SMTP')], ['gmail', I18n.t('Gmail (sign in with Google)')], ['graph', I18n.t('Microsoft (Outlook / Microsoft 365)')], ['ews', I18n.t('Exchange (EWS)')]], 'imap')}
        </div>
        ${!e ? `<div class="full w-imap-only"><label>Provider</label>
          ${sel('w-preset', [['', I18n.t('Choose to prefill server settings…')], ...wizardPresets.map((p) => [p.id, p.name])], '')}
          <div class="set-hint" id="w-preset-help" style="display:none"></div></div>` : ''}
        <div class="full"><label>Account name</label><input id="w-label" value="${v(e?.label)}" placeholder="Home, Work, GMX…"></div>
        <div class="full"><label>E-mail address</label><input id="w-email" type="email" value="${v(e?.email)}" placeholder="you@example.com"></div>
        <div class="full"><label>Sender name</label><input id="w-sendername" value="${v(e?.senderName)}" placeholder="Shown next to your e-mail address on outgoing mail"></div>
        <div class="full"><label>Color</label>
          <div class="color-picker" id="w-colors">
            ${ACCOUNT_COLORS.map((c) => `<span class="color-swatch${c === defaultColor ? ' selected' : ''}" data-color="${c}" style="background:${c}" title="${c}"></span>`).join('')}
            <input type="color" id="w-color-custom" value="${defaultColor}" title="${I18n.t('Custom color')}">
          </div>
          <input type="hidden" id="w-color" value="${v(defaultColor)}">
        </div>

        <div class="w-oauth-fields">
          <div class="wiz-section">${I18n.t('Sign in')}</div>
          <div class="full"><label>${I18n.t('Provider')}</label>
            ${sel('w-oauth-provider', oauthProviders.map((p) => [p.id, p.label]), wizardOAuth.provider)}
          </div>
          <div class="full">
            <button class="btn-sm" id="w-oauth-signin">${I18n.t('Sign in')}</button>
            <div class="set-hint" id="w-oauth-status" style="margin-top:6px">${
              wizardOAuth.email
                ? `✓ ${esc(I18n.t('Signed in as'))} <strong>${esc(wizardOAuth.email)}</strong> — ${esc(I18n.t('sign in again only if it stops working.'))}`
                : esc(I18n.t('Not signed in yet.'))
            }</div>
          </div>
          ${e && type === 'gmail' ? `<div class="full">
            <button class="link-btn" id="w-oauth-revert">${I18n.t('Use an app password instead')}</button>
            <div class="set-hint" style="margin-top:4px">${I18n.t('Goes back to a stored password without recreating the account — you keep the same cached mail, analytics, identities and settings.')}</div>
          </div>` : ''}
          <p class="set-hint">${I18n.t('The sign-in page opens in a separate window (or your browser, on Android) — neither Microsoft nor Google allows it to run inside another app. Hmelj never sees your password; it stores only the token the sign-in hands back, encrypted like any other credential.')}</p>
          <p class="set-hint w-graph-only">${I18n.t('Hmelj reads and sends this mailbox through Microsoft Graph, so there is no server, port or password to fill in — and nothing to switch on in your Outlook settings.')}</p>
          <p class="set-hint w-gmail-only">${I18n.t('This is the alternative to a Gmail app password: Hmelj talks to imap.gmail.com and smtp.gmail.com exactly as before, but proves itself with the token from this sign-in instead of a stored password. Nothing to fill in, and no 2-step-verification app password to create.')}</p>
          <p class="set-hint w-gmail-only">${I18n.t('Google will warn that the app is not verified — that app is this Hmelj server, registered by your own admin, so choose Advanced → Continue.')}</p>
        </div>

        <div class="w-imap-fields">
          <div class="wiz-section">Incoming mail (IMAP)</div>
          <div><label>Server</label>
            <div class="host-port">
              <input id="w-ihost" class="host-input" value="${v(e?.imap?.host)}" placeholder="imap.example.com">
              <input id="w-iport" class="port-input" type="number" value="${v(e?.imap?.port, 993)}" title="${I18n.t('Port')}">
            </div>
          </div>
          <div class="w-pass-only"><label>Username</label><input id="w-iuser" value="${v(e?.imap?.user)}" placeholder="(defaults to e-mail)"></div>
          <div class="w-pass-only"><label>Password</label><input id="w-ipass" type="password" placeholder="${e ? '(unchanged)' : ''}"></div>
          <div class="wiz-check-group">
            <label class="mini-toggle"><input type="checkbox" id="w-itls" ${e ? (e.imap?.secure !== false ? 'checked' : '') : 'checked'}> Use TLS (recommended)</label>
            <label class="mini-toggle"><input type="checkbox" id="w-iselfsigned" ${e && e.imap?.tlsRejectUnauthorized === false ? 'checked' : ''}> Allow self-signed certificate</label>
          </div>
          <div class="full">
            <label class="mini-toggle"><input type="checkbox" id="w-second-conn" ${e?.allowSecondConnection ? 'checked' : ''}> Allow a second connection</label>
            <div class="set-hint" style="margin-top:4px">Lets background sync use its own connection instead of sharing the one interactive requests (opening a message, viewing an attachment) use — opening something no longer waits behind an in-flight sync. Off by default; only turn this on if your provider allows more than one connection per account.</div>
          </div>
          <div class="wiz-section">Outgoing mail (SMTP)</div>
          <div class="full w-pass-only">
            <label class="mini-toggle"><input type="checkbox" id="w-samehost" ${sameServer ? 'checked' : ''}> Same server as IMAP</label>
            <label class="mini-toggle"><input type="checkbox" id="w-samecreds" ${sameCreds ? 'checked' : ''}> Same credentials as IMAP</label>
          </div>
          <div class="w-host-field"><label>Server</label>
            <div class="host-port">
              <input id="w-shost" class="host-input" value="${v(e?.smtp?.host)}" placeholder="smtp.example.com">
              <input id="w-sport" class="port-input" type="number" value="${v(e?.smtp?.port, 465)}" title="${I18n.t('Port')}">
            </div>
          </div>
          <div class="w-host-field wiz-check-group"><label class="mini-toggle"><input type="checkbox" id="w-stls" ${e ? (e.smtp?.secure !== false ? 'checked' : '') : 'checked'}> Use TLS (recommended)</label></div>
          <div class="w-cred-field w-pass-only"><label>Username</label><input id="w-suser" value="${v(e?.smtp?.user)}"></div>
          <div class="w-cred-field w-pass-only"><label>Password</label><input id="w-spass" type="password" placeholder="${e ? '(unchanged)' : ''}"></div>
        </div>

        <div class="w-ews-fields">
          <div class="wiz-section">${I18n.t('Exchange server (EWS)')}</div>
          <div class="full"><label>${I18n.t('Server URL')}</label><input id="w-ews-url" value="${v(e?.ews?.url)}" placeholder="https://mail.example.com/EWS/Exchange.asmx"></div>
          <div><label>${I18n.t('Domain')}</label><input id="w-ews-domain" value="${v(e?.ews?.domain)}" placeholder="(NTLM domain, if required)"></div>
          <div><label>Username</label><input id="w-ews-user" value="${v(e?.ews?.user)}" placeholder="(defaults to e-mail)"></div>
          <div><label>Password</label><input id="w-ews-pass" type="password" placeholder="${e ? '(unchanged)' : ''}"></div>
          <div class="wiz-check-group">
            <label class="mini-toggle"><input type="checkbox" id="w-ews-selfsigned" ${e && e.ews?.tlsRejectUnauthorized === false ? 'checked' : ''}> Allow self-signed certificate</label>
          </div>
          <p class="set-hint">${I18n.t('Talks to an on-premises Exchange server over EWS, authenticating with NTLM. Reading, sending, moving, deleting, flagging, search and meeting responses all work; live monitoring is a 15-second pull subscription rather than true push.')}</p>
        </div>

        <div class="wiz-section">${I18n.t('New mail')}</div>
        <div class="full">
          <label>${I18n.t('Check for new mail')}</label>
          <select id="w-monitor">
            <option value="idle" ${monitorValue === 'idle' ? 'selected' : ''}>${I18n.t('Live — as it arrives')}${type === 'ews' ? ' (~15s)' : (type === 'graph' ? ' (~30s)' : '')}</option>
            <option value="30000" ${monitorValue === '30000' ? 'selected' : ''}>${I18n.t('Every 30 seconds')}</option>
            <option value="60000" ${monitorValue === '60000' ? 'selected' : ''}>${I18n.t('Every minute')}</option>
            <option value="120000" ${monitorValue === '120000' ? 'selected' : ''}>${I18n.t('Every 2 minutes')}</option>
            <option value="300000" ${monitorValue === '300000' ? 'selected' : ''}>${I18n.t('Every 5 minutes')}</option>
            <option value="900000" ${monitorValue === '900000' ? 'selected' : ''}>${I18n.t('Every 15 minutes')}</option>
          </select>
          <div class="set-hint" style="margin-top:4px">${type === 'ews'
            ? I18n.t('Live asks Exchange every 15 seconds what has actually changed (a pull subscription) — more accurate than a plain timer, which can miss mail on a busy mailbox. True push is not possible over this Exchange connection. Everything else checks on a fixed timer.')
            : type === 'graph'
              ? I18n.t('Live checks your Inbox at Microsoft every 30 seconds — one tiny request per check, well within what Microsoft allows. True push would need this Hmelj to be reachable from the public internet, so it is not used. Everything else checks on a slower fixed timer.')
              : I18n.t('Live keeps one extra connection open to this server (IMAP IDLE) and notifies you within about a second. Everything else checks on a timer — pick a longer one for mailboxes you do not need to hear about immediately.')}
            ${I18n.t('Live accounts still run a slow background check as a safety net.')}</div>
        </div>

        <div class="wiz-status" id="w-status"></div>
      </div>
      <div class="row" style="margin-top:14px">
        <button class="link-btn" id="w-cancel">${I18n.t('Cancel')}</button>
        <span class="spacer"></span>
        <button class="send-btn" id="w-submit">${I18n.t('Test & save')}</button>
      </div>`;

    const g = (id) => document.getElementById(id);
    // Opened from a click far down a long list, the wizard inherits that scroll
    // position and lands somewhere in its own middle — the type selector and
    // every field above it off-screen. Same trap the filter editor had; same
    // fix (see renderFilterEditor).
    body().scrollTop = 0;
    // The type selector is the first decision on a new account, the name field
    // the first on an existing one. Not on a phone: focusing there throws the
    // on-screen keyboard or the select's own picker over the form before anyone
    // asked to type.
    if (!isMobileViewport()) (g('w-type') || g('w-label'))?.focus();
    const leave = () => {
      accountsView = 'list';
      renderAccountsTab();
      body().scrollTop = accountsListScrollTop;
      if (wizardDoneResolver) { wizardDoneResolver(null); wizardDoneResolver = null; }
    };
    document.getElementById('w-back').addEventListener('click', leave);
    document.getElementById('w-cancel').addEventListener('click', leave);

    // Type selector swaps between four mutually exclusive field sets (new
    // accounts only — editing shows a fixed label instead). Neither sign-in type
    // has server, port, TLS or password fields at all: signing in IS the
    // configuration, which is why that block is genuinely separate rather than a
    // variation on the IMAP one. Gmail is the odd one out only in that it ends
    // up an IMAP account underneath — but there is still nothing for the user to
    // type, so it shows the sign-in block and none of the IMAP one.
    const imapOnlyFields = [...body().querySelectorAll('.w-imap-only')];
    const passOnlyFields = [...body().querySelectorAll('.w-pass-only')];
    const graphOnlyFields = [...body().querySelectorAll('.w-graph-only')];
    const gmailOnlyFields = [...body().querySelectorAll('.w-gmail-only')];
    const imapFields = body().querySelector('.w-imap-fields');
    const ewsFields = body().querySelector('.w-ews-fields');
    const oauthFields = body().querySelector('.w-oauth-fields');
    const typeSel = g('w-type');
    // wizardRevert wins: the user asked to go back to a password, so the form
    // has to become the plain IMAP one even though the account still signs in.
    const currentType = () => (wizardRevert ? 'imap' : (typeSel ? typeSel.value : type));
    // 'graph' and 'gmail' both sign in; they differ in which providers apply.
    const oauthKind = (t) => (t === 'graph' ? 'graph' : t === 'gmail' ? 'imap' : '');
    const syncType = () => {
      const t = currentType();
      const kind = oauthKind(t);
      const showsImapFields = t === 'imap';
      imapFields.hidden = !showsImapFields;
      ewsFields.hidden = t !== 'ews';
      oauthFields.hidden = !kind;
      graphOnlyFields.forEach((f) => { f.hidden = t !== 'graph'; });
      gmailOnlyFields.forEach((f) => { f.hidden = t !== 'gmail'; });
      imapOnlyFields.forEach((f) => { f.hidden = !showsImapFields; }); // the provider preset picker
      syncHost();
      syncCreds();
      // Runs last: it has to win over syncCreds(), which would otherwise
      // reveal the SMTP username/password it just unchecked "same credentials"
      // for.
      passOnlyFields.forEach((f) => { f.hidden = !showsImapFields; });
      // Only the providers that belong to this type, and never a stale
      // selection left behind by switching between the two sign-in types.
      const provSel = g('w-oauth-provider');
      if (provSel && kind) {
        const wanted = providersOfKind(kind);
        if (!wanted.some((p) => p.id === provSel.value)) {
          wizardOAuth = { provider: defaultProvider(kind), state: '', email: '' };
        }
        provSel.innerHTML = wanted.map((p) => `<option value="${escAttr(p.id)}"${p.id === wizardOAuth.provider ? ' selected' : ''}>${esc(p.label)}</option>`).join('');
        // One provider of this kind is the normal case (Microsoft for Graph,
        // Google for Gmail) — a picker with a single entry is just noise.
        provSel.closest('div').hidden = wanted.length < 2;
      }
      if (wizardRevert) {
        const lab = g('w-type-label');
        if (lab) lab.textContent = typeLabel.imap;
      }
      updateOAuthStatus();
    };

    // Reverting a signed-in account to a stored password. Only the form changes
    // here — nothing is saved until "Test & save", so this is cancellable by
    // simply going back.
    g('w-oauth-revert')?.addEventListener('click', () => {
      wizardRevert = true;
      syncType();
      const status = g('w-status');
      if (status) {
        status.className = 'wiz-status';
        status.textContent = I18n.t('Enter the app password below, then press Test & save.');
      }
      g('w-ipass')?.focus();
    });

    // "Same server / credentials as IMAP" each show/hide their own subset of
    // fields (not just disable — unchecking should visibly reveal the
    // inputs, not leave them looking greyed-out-but-present).
    const hostFields = [...body().querySelectorAll('.w-host-field')];
    const credFields = [...body().querySelectorAll('.w-cred-field')];
    const sameHostCb = g('w-samehost');
    const sameCredsCb = g('w-samecreds');
    const syncHost = () => hostFields.forEach((f) => { f.hidden = sameHostCb.checked; });
    const syncCreds = () => credFields.forEach((f) => { f.hidden = sameCredsCb.checked; });
    sameHostCb?.addEventListener('change', syncHost); syncHost();
    sameCredsCb?.addEventListener('change', syncCreds); syncCreds();

    /* ---- Microsoft sign-in (see public/js/oauth.js) ---- */

    function setOAuthStatus(kind, html) {
      const el = g('w-oauth-status');
      if (!el) return;
      el.className = kind === 'err' ? 'set-hint wiz-status err' : 'set-hint';
      el.innerHTML = html;
    }

    // Signed in / not signed in, plus the gate on "Test & save": with no
    // completed sign-in there is no credential to test, so the button would
    // only ever produce a confusing failure.
    function updateOAuthStatus() {
      const submitBtn = g('w-submit');
      if (!oauthKind(currentType())) { if (submitBtn) submitBtn.disabled = false; return; }
      const provider = oauthProviders.find((p) => p.id === (g('w-oauth-provider')?.value || wizardOAuth.provider));
      const signedIn = !!(wizardOAuth.state || e?.graph || e?.oauth);
      if (submitBtn) submitBtn.disabled = !signedIn;
      const signInBtn = g('w-oauth-signin');
      if (signInBtn && provider) signInBtn.textContent = I18n.t('Sign in with') + ' ' + provider.label;
      if (!provider || !provider.configured) {
        setOAuthStatus('err', esc(I18n.t('This server has no OAuth client set up for this provider yet. An admin needs to add one under Settings → Admin → OAuth providers.')));
        if (signInBtn) signInBtn.disabled = true;
        return;
      }
      if (signInBtn) signInBtn.disabled = false;
      if (wizardOAuth.email) {
        setOAuthStatus('ok', `✓ ${esc(I18n.t('Signed in as'))} <strong>${esc(wizardOAuth.email)}</strong>`);
      } else {
        setOAuthStatus('ok', esc(I18n.t('Not signed in yet.')));
      }
    }

    g('w-oauth-provider')?.addEventListener('change', () => {
      wizardOAuth = { provider: g('w-oauth-provider').value, state: '', email: '' };
      updateOAuthStatus();
    });

    g('w-oauth-signin')?.addEventListener('click', async () => {
      const email = g('w-email').value.trim();
      if (!email) {
        setOAuthStatus('err', esc(I18n.t('Enter the e-mail address first — the sign-in needs to know which mailbox to ask for.')));
        g('w-email').focus();
        return;
      }
      const provider = g('w-oauth-provider').value;
      const btn = g('w-oauth-signin');
      btn.disabled = true;
      try {
        const r = await OAuthFlow.signIn({
          provider,
          email,
          accountId: e?.id || null,
          onStatus: (kind, detail) => {
            if (kind === 'manual') {
              // Popup blocked, or an older Android build with no Custom Tab
              // bridge. A link the user taps themselves is always allowed —
              // and on that older Android build a same-tab navigation is what
              // the native shell punts to the system browser.
              setOAuthStatus('ok', `${esc(I18n.t('Your browser blocked the sign-in window.'))} <a href="${escAttr(detail.authUrl)}"${detail.sameTab ? '' : ' target="_blank" rel="noopener"'}>${esc(I18n.t('Open the sign-in page'))}</a>`);
            } else if (kind === 'waiting') {
              setOAuthStatus('ok', esc(I18n.t('Waiting for you to finish signing in…')));
            }
          },
        });
        wizardOAuth = { provider, state: r.state, email: r.email };
        // Saves the user typing the obvious thing twice.
        if (!g('w-label').value.trim()) g('w-label').value = r.email;
        updateOAuthStatus();
      } catch (err) {
        setOAuthStatus('err', esc(err.message));
        if (g('w-submit')) g('w-submit').disabled = true;
      } finally {
        btn.disabled = false;
      }
    });

    typeSel?.addEventListener('change', syncType);
    syncType();

    // Color picker: swatches + a custom picker, both just set the same hidden input.
    const colorHidden = g('w-color');
    const colorCustom = g('w-color-custom');
    body().querySelectorAll('.color-swatch').forEach((sw) => sw.addEventListener('click', () => {
      colorHidden.value = sw.dataset.color;
      colorCustom.value = sw.dataset.color;
      body().querySelectorAll('.color-swatch').forEach((x) => x.classList.toggle('selected', x === sw));
    }));
    colorCustom?.addEventListener('input', () => {
      colorHidden.value = colorCustom.value;
      body().querySelectorAll('.color-swatch').forEach((x) => x.classList.remove('selected'));
    });

    // Preset picker: prefill server fields + show the provider's help text.
    const presetSel = g('w-preset');
    const help = g('w-preset-help');
    presetSel?.addEventListener('change', () => {
      const p = wizardPresets.find((x) => x.id === presetSel.value);
      if (!p) { help.style.display = 'none'; return; }
      g('w-ihost').value = p.imapHost;
      g('w-iport').value = p.imapPort;
      g('w-itls').checked = p.imapTls !== false;
      sameHostCb.checked = false; syncHost();
      g('w-shost').value = p.smtpHost;
      g('w-sport').value = p.smtpPort;
      g('w-stls').checked = p.smtpTls !== false;
      if (p.helpText || p.helpUrl) {
        help.style.display = '';
        help.innerHTML = esc(p.helpText || '') + (p.helpUrl ? ` <a href="${escAttr(p.helpUrl)}" target="_blank" rel="noopener">${esc(p.helpUrl)}</a>` : '');
      } else {
        help.style.display = 'none';
      }
    });

    document.getElementById('w-submit').addEventListener('click', () => submitWizard(e));
  }

  async function submitWizard(existingAcc) {
    const g = (id) => document.getElementById(id);
    const status = g('w-status');
    // An account's type never changes after creation (see renderAccountWizard) —
    // the existing account is authoritative on edit; the selector only exists
    // when adding new.
    //
    // 'gmail' only exists in this form: on the wire it is an ordinary IMAP
    // account whose credential is an `oauth` block instead of a password, which
    // is also how an existing one is recognised here (see renderAccountWizard).
    const wizType = wizardRevert
      ? 'imap'
      : existingAcc
        ? (existingAcc.oauth ? 'gmail' : existingAcc.type || 'imap')
        : (g('w-type')?.value || 'imap');
    const isGraph = wizType === 'graph';
    const isGmail = wizType === 'gmail';
    const signsIn = isGraph || isGmail;
    const type = isGmail ? 'imap' : wizType;
    const input = {
      type,
      ...(signsIn ? {
        // `id` lets the server's connection test fall back to this account's
        // stored token when re-testing an edit without signing in again.
        ...(existingAcc ? { id: existingAcc.id } : {}),
        [isGraph ? 'graph' : 'oauth']: {
          provider: wizardOAuth.provider,
          // Omitted when editing without a fresh sign-in — the server then
          // keeps the tokens it already has, the same way a blank password
          // field means "leave it alone".
          ...(wizardOAuth.state ? { state: wizardOAuth.state } : {}),
        },
      } : {}),
      label: g('w-label').value.trim(),
      email: g('w-email').value.trim(),
      senderName: g('w-sendername').value.trim(),
      color: g('w-color').value,
      // 'idle' vs a poll interval — one select, two stored fields.
      monitorMode: g('w-monitor').value === 'idle' ? 'idle' : 'poll',
      pollIntervalMs: g('w-monitor').value === 'idle' ? null : (+g('w-monitor').value || null),
      // An account that signs in has no server fields to read at all — that
      // whole block is hidden for it, and reading it would only pick up empty
      // inputs (and, on an edit, overwrite the stored host with them).
      ...(signsIn ? {} : type === 'ews' ? {
        ews: {
          url: g('w-ews-url').value.trim(),
          domain: g('w-ews-domain').value.trim(),
          user: g('w-ews-user').value.trim() || g('w-email').value.trim(),
          pass: g('w-ews-pass').value,
          tlsRejectUnauthorized: !g('w-ews-selfsigned').checked,
        },
      } : {
        allowSecondConnection: g('w-second-conn').checked,
        // Explicit null, not merely absent: absent means "keep the sign-in this
        // account already has" (an ordinary edit), null means "drop it, I am
        // giving you a password instead" — see server/accounts.js#saveAccount.
        ...(wizardRevert ? { oauth: null } : {}),
        imap: {
          host: g('w-ihost').value.trim(),
          port: +g('w-iport').value || 993,
          secure: g('w-itls').checked,
          user: g('w-iuser').value.trim() || g('w-email').value.trim(),
          pass: g('w-ipass').value,
          tlsRejectUnauthorized: !g('w-iselfsigned').checked,
        },
        smtp: {
          sameServer: g('w-samehost').checked,
          sameCredentials: g('w-samecreds').checked,
          host: g('w-shost').value.trim(),
          port: +g('w-sport').value || 465,
          secure: g('w-stls').checked,
          user: g('w-suser').value.trim(),
          pass: g('w-spass').value,
        },
      }),
    };
    if (signsIn) {
      // The credential here is the completed sign-in, not a password — and an
      // address, so Hmelj knows which mailbox the sign-in is meant for.
      if (!input.email) {
        status.className = 'wiz-status err';
        status.textContent = I18n.t('E-mail address is required');
        return;
      }
      if (!wizardOAuth.state && !existingAcc?.graph && !existingAcc?.oauth) {
        status.className = 'wiz-status err';
        status.textContent = I18n.t('Press the sign-in button first — there is no password to test with.');
        return;
      }
    } else if (type === 'ews') {
      if (!input.email || !input.ews.url || (!existingAcc && !input.ews.pass)) {
        status.className = 'wiz-status err';
        status.textContent = I18n.t('E-mail, Exchange server URL and password are required');
        return;
      }
    } else if (!input.email || !input.imap.host || (!existingAcc && !input.imap.pass)) {
      status.className = 'wiz-status err';
      status.textContent = I18n.t('E-mail, IMAP server and password are required');
      return;
    } else if (wizardRevert && !input.imap.pass) {
      // A blank password normally means "keep the stored one" — but there is no
      // stored one here, only the sign-in being given up, so saving blank would
      // leave the account unable to connect at all.
      status.className = 'wiz-status err';
      status.textContent = I18n.t('Enter the app password to switch back to — otherwise this account would have no way to sign in.');
      return;
    }
    status.className = 'wiz-status';
    status.textContent = I18n.t('Testing connection… this can take a while for a large mailbox.');
    try {
      // for edits with unchanged password we can't test — skip test, just save
      let detected = {};
      // An account that signs in always has something to test with: either the
      // sign-in just completed, or the token already stored against it.
      const canTest = signsIn
        ? true
        : (type === 'ews' ? !!input.ews.pass : !!input.imap.pass);
      if (canTest) detected = await API.testAccount(input);
      const saved = await API.saveAccount({ ...input, ...detected }, existingAcc?.id);
      toast(I18n.t('Mail account saved') + ' ✓');
      // The server guarantees a new account gets an identity (accounts.js#saveAccount);
      // just pull the fresh list so Compose's dropdown picks it up right away.
      if (!existingAcc) {
        state.identities = await API.identities();
        Compose.setIdentities(state.identities);
      }
      accountsView = 'list';
      await reloadAccounts();
      body().scrollTop = accountsListScrollTop;
      if (wizardDoneResolver) { wizardDoneResolver(saved); wizardDoneResolver = null; }
    } catch (err) {
      // Inline error, form left exactly as typed — unlike the old
      // Dialog.form version, nothing here needs to close/rebuild to show it.
      status.className = 'wiz-status err';
      status.textContent = I18n.t('Connection test failed: ') + err.message;
    }
  }

  /** Public entry point (see the returned object below) — used by app.js for
   * the first-run "you have zero mail accounts yet" bootstrap, the one
   * caller that needs the wizard before the Settings modal would otherwise
   * be open. Opens the modal straight to the inline wizard and resolves
   * once the user saves or backs out. */
  function accountWizard() {
    return new Promise((resolve) => {
      wizardDoneResolver = resolve;
      wizardTarget = null;
      accountsView = 'wizard';
      open('accounts');
    });
  }

  /* ---------- identities ---------- */

  /** Old signatures are plain text with real `\n` line breaks (what the old
   * textarea produced); the rich editor saves real HTML. Detect which one
   * we're looking at so both keep rendering correctly. */
  function sigLooksLikeHtml(s) { return /<[a-z][\s\S]*>/i.test(s || ''); }
  function sigToEditableHtml(s) {
    if (!s) return '';
    return sigLooksLikeHtml(s) ? s : esc(s).replace(/\n/g, '<br>');
  }

  /** One signature's editor. `i` is the identity's index, `j` the signature's
   *  within it — both in every element id, so wireSignatureEditors (which just
   *  walks every .sig-editor in the DOM) keeps working unchanged now that there
   *  is more than one per identity. */
  function signatureEditor(sig, i, j, isDefault) {
    const html = sigToEditableHtml(sig.html);
    return `<div class="sig-block" data-i="${i}" data-j="${j}">
      <div class="row" style="gap:8px">
        <input class="grow" id="id-signame-${i}-${j}" value="${escAttr(sig.name || '')}"
          placeholder="${escAttr(I18n.t('Signature name'))}" aria-label="${escAttr(I18n.t('Signature name'))}">
        <label class="mini-toggle" title="${escAttr(I18n.t('Used unless you pick another while writing'))}">
          <input type="radio" name="id-sigdef-${i}" id="id-sigdef-${i}-${j}" ${isDefault ? 'checked' : ''}>
          <span>${esc(I18n.t('Default'))}</span>
        </label>
        <button type="button" class="link-btn sig-del" data-i="${i}" data-j="${j}" style="color:var(--danger)">✕</button>
      </div>
      ${richEditor(`id-sig-${i}-${j}`, html)}
    </div>`;
  }

  /**
   * A rich editor with the composer's own toolbar — used by signatures and by
   * templates, both of which end up INSIDE a message and so want exactly the
   * options a message has.
   *
   * The buttons come from Compose.richToolbarHtml() rather than being written
   * out here: this pane used to carry its own shorter copy (bold, italic,
   * underline, one list, link, clear), which is how "the editor in Settings" and
   * "the editor in the composer" quietly became two different things. Two extra
   * buttons are appended that only make sense here — insert an image, and edit
   * the HTML source.
   *
   * `key` is the element-id stem; the hidden input at `#${key}` is what the tab
   * is saved from, and wireRichEditors keeps it in step with whichever of the
   * two views (rich or source) is showing.
   */
  function richEditor(key, html) {
    const extras = '<span class="tb-sep"></span>'
      + `<button type="button" class="sig-img" title="${escAttr(I18n.t('Insert image'))}" tabindex="-1">🖼</button>`
      + `<button type="button" class="sig-source" title="${escAttr(I18n.t('View HTML source'))}" tabindex="-1">&lt;/&gt;</button>`;
    return `<div class="sig-editor">
      <div class="editor-toolbar sig-toolbar"><div class="tb-scroll">${Compose.richToolbarHtml({ extras })}</div></div>
      <div class="sig-rich" id="${key}-rich" contenteditable="true" data-no-i18n>${html}</div>
      <textarea class="sig-src" id="${key}-src" hidden>${esc(html)}</textarea>
      <input type="file" class="sig-img-input" accept="image/*" hidden>
      <input type="hidden" id="${key}" value="${escAttr(html)}">
    </div>`;
  }

  /** An identity's signatures, always an array — the server normalises this on
   *  every read (store.js#normalizeIdentities), so this only covers an identity
   *  that reached the draft some other way. */
  const sigsOf = (id) => (Array.isArray(id.signatures) ? id.signatures : []);

  /** Collapsed by default (name/e-mail/reply-to/default-radio only) — expand
   * reveals organization, send-via-account, signature-used, and the
   * signature editor. The default-radio deliberately stays outside the
   * expand: it shares name="id-default" across all cards so the browser
   * enforces "exactly one checked," but only for radios actually present in
   * the DOM — hiding it behind expand would let two different cards each
   * carry a stale/fresh `default: true` past collectIdentities() with
   * neither one's radio visible to reconcile against the other. */
  function identityCard(id, i, indented) {
    const expanded = expandedIdentities.has(i);
    return `<div class="card${indented ? ' id-alias' : ''}" data-i="${i}">
      <div class="row">
        <div class="grow"><label>Name</label><br>${txt(`id-name-${i}`, id.name)}</div>
        <div class="grow"><label>E-mail</label><br>${txt(`id-email-${i}`, id.email)}</div>
        <div class="grow"><label>Reply-To</label><br>${txt(`id-replyto-${i}`, id.replyTo)}</div>
        <div><label>Default</label><br><input type="radio" name="id-default" id="id-def-${i}" ${id.default ? 'checked' : ''}></div>
        <button class="icon-btn small id-expand-toggle" data-i="${i}" title="${expanded ? I18n.t('Collapse') : I18n.t('Expand')}">${expanded ? '▲' : '▼'}</button>
        <button class="icon-btn small" data-del-id="${i}" title="${I18n.t('Remove identity')}" style="color:var(--danger)">🗑</button>
      </div>
      ${expanded ? `
      <div class="row">
        <div class="grow"><label>Organization</label><br>${txt(`id-org-${i}`, id.organization)}</div>
        <div><label>Send via account</label><br>${sel(`id-acct-${i}`, allAccounts().map((a) => [a.id, a.label]), id.accountId || allAccounts()[0]?.id)}</div>
        <div><label>Signature used</label><br>${sel(`id-sigon-${i}`, [['new', 'On new messages'], ['new-reply', 'On new & replies'], ['always', 'Every time'], ['never', 'Never']], id.signatureOn || 'new-reply')}</div>
        <div><label>&nbsp;</label><br><label class="mini-toggle">${chk(`id-sigdelim-${i}`, id.signatureDelimiter !== false)} ${I18n.t('Include "-- " delimiter')}</label></div>
      </div>
      <div>
        <label>${I18n.t('Signatures')}</label>
        ${sigsOf(id).map((sg, j) => signatureEditor(sg, i, j, sg.id === id.defaultSignatureId)).join('')}
        ${!sigsOf(id).length ? `<p class="set-hint" style="grid-column:auto">${esc(I18n.t('No signature yet.'))}</p>` : ''}
        <button type="button" class="link-btn sig-add" data-i="${i}">+ ${esc(I18n.t('Add signature'))}</button>
        ${sigsOf(id).length > 1 ? `<div class="set-hint">${esc(I18n.t('Pick which one a message uses from the ⋯ menu in the composer.'))}</div>` : ''}
      </div>` : ''}
    </div>`;
  }

  /** Wires toolbar buttons for every signature editor currently in the DOM —
   * called after renderIdentities() sets body().innerHTML. Reuses the same
   * document.execCommand pattern as the compose editor (see compose.js). */
  /** Wires every rich editor currently in the DOM — signatures and templates
   *  both. Called after the tab's innerHTML is set. */
  function wireSignatureEditors() {
    body().querySelectorAll('.sig-editor').forEach((wrap) => {
      const rich = wrap.querySelector('.sig-rich');
      const src = wrap.querySelector('.sig-src');
      const hidden = wrap.querySelector('input[type="hidden"]');
      const imgInput = wrap.querySelector('.sig-img-input');
      let savedRange = null;

      const syncHidden = () => { hidden.value = rich.hidden ? src.value : rich.innerHTML; };
      src.addEventListener('input', syncHidden);

      // The toolbar's own buttons, the four pickers, the ⋯ menu, the
      // saved-selection handling and the pressed-state sync all come from the
      // composer's engine — see Compose.wireRichEditor. `menu: 'basic'` drops
      // the two entries that only mean something inside a real message.
      Compose.wireRichEditor(wrap.querySelector('.editor-toolbar'), rich, { onChange: syncHidden, menu: 'basic' });

      wrap.querySelector('.sig-img').addEventListener('mousedown', () => {
        const sel = window.getSelection();
        savedRange = sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
      });
      wrap.querySelector('.sig-img').addEventListener('click', () => imgInput.click());
      imgInput.addEventListener('change', () => {
        const file = imgInput.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
          rich.focus();
          const sel = window.getSelection();
          if (savedRange) { sel.removeAllRanges(); sel.addRange(savedRange); }
          document.execCommand('insertImage', false, reader.result);
          syncHidden();
        };
        reader.readAsDataURL(file);
        imgInput.value = '';
      });

      wrap.querySelector('.sig-source').addEventListener('click', () => {
        if (rich.hidden) { // currently showing source -> switch back to rich
          rich.innerHTML = src.value;
          rich.hidden = false; src.hidden = true;
        } else { // currently showing rich -> switch to source
          src.value = rich.innerHTML;
          rich.hidden = true; src.hidden = false;
        }
        syncHidden();
      });
    });
  }

  /** Group identities by their account: the account's own auto-created identity
   * (id === accountId) is the group's "main" entry, any others are aliases
   * (rendered indented) — e.g. server-side mail aliases the user wants to send
   * from. Identities whose account no longer exists fall into "Other". */
  function renderIdentities() {
    // An identity is bound to a sending account — that is what decides which
    // SMTP server a reply leaves through and whose Sent folder it lands in.
    // With no accounts, "+ Add identity" pushed one with `accountId: undefined`
    // (allAccounts()[0]?.id), which rendered under the "Other" catch-all group
    // and could never send anything. Same guard the Folders and Scheduler tabs
    // already use.
    if (!state.accounts.length) {
      body().innerHTML = `<p class="set-hint" style="grid-column:auto">${esc(I18n.t('No mail accounts yet — an identity needs an account to send through.'))}</p>`;
      return;
    }
    const withIndex = identities.map((id, i) => ({ id, i }));
    const groups = allAccounts().map((a) => {
      const items = withIndex.filter((x) => x.id.accountId === a.id);
      items.sort((x, y) => (x.id.id === a.id ? -1 : y.id.id === a.id ? 1 : 0));
      return { account: a, items };
    });
    const orphans = withIndex.filter((x) => !state.accounts.some((a) => a.id === x.id.accountId));

    body().innerHTML = `<p><button class="link-btn" id="id-back-to-accounts">← ${I18n.t('Back to accounts')}</button></p>
      <div id="id-list">
      ${groups.map((g) => `
        <div class="id-group" id="idgrp-${g.account.id}">
          <div class="id-group-header">
            <span class="acct-dot" style="background:${escAttr(g.account.color)}"></span>
            <b>${esc(g.account.label)}</b>
            <span class="set-hint" style="margin:0">${esc(g.account.email)}</span>
            <span class="spacer"></span>
            <button class="link-btn id-add-alias" data-acct="${g.account.id}">+ Add alias</button>
          </div>
          <div class="card-list">${g.items.map((x, idx) => identityCard(x.id, x.i, idx > 0)).join('')}</div>
        </div>`).join('')}
      ${orphans.length ? `<div class="id-group"><div class="id-group-header"><b>Other</b></div>
        <div class="card-list">${orphans.map((x) => identityCard(x.id, x.i, true)).join('')}</div></div>` : ''}
      </div>
      <p><button class="link-btn" id="id-add">+ Add identity</button></p>`;

    document.getElementById('id-back-to-accounts').addEventListener('click', () => switchTab('accounts'));
    document.getElementById('id-add').addEventListener('click', () => {
      collectIdentities();
      identities.push({ id: uid(), name: '', email: '', organization: '', replyTo: '', signatures: [], defaultSignatureId: null, signatureOn: 'new-reply', signatureDelimiter: true, accountId: allAccounts()[0]?.id, default: identities.length === 0 });
      renderIdentities();
    });
    body().querySelectorAll('.id-add-alias').forEach((b) => b.addEventListener('click', () => {
      collectIdentities();
      identities.push({ id: uid(), name: '', email: '', organization: '', replyTo: '', signatures: [], defaultSignatureId: null, signatureOn: 'new-reply', signatureDelimiter: true, accountId: b.dataset.acct, default: identities.length === 0 });
      renderIdentities();
    }));
    body().querySelectorAll('[data-del-id]').forEach((b) => b.addEventListener('click', async () => {
      if (!await Dialog.confirm(I18n.t('Delete this identity?'), { title: I18n.t('Delete'), okLabel: I18n.t('Delete'), danger: true })) return;
      collectIdentities();
      identities.splice(+b.dataset.delId, 1);
      renderIdentities();
    }));
    body().querySelectorAll('.id-expand-toggle').forEach((b) => b.addEventListener('click', () => {
      collectIdentities();
      const i = +b.dataset.i;
      expandedIdentities.has(i) ? expandedIdentities.delete(i) : expandedIdentities.add(i);
      renderIdentities();
    }));

    // Both of these re-render the whole tab, so both collect first or every
    // in-progress edit in a sibling card is lost — the same contract every
    // other list on this tab keeps (see the Groups card, the saved searches).
    body().querySelectorAll('.sig-add').forEach((b) => b.addEventListener('click', () => {
      collectIdentities();
      const id = identities[+b.dataset.i];
      const list = sigsOf(id);
      // Named for its position rather than left blank: an unnamed signature is
      // an unlabelled row in the composer's picker, and the server would name
      // it anyway on save.
      id.signatures = [...list, { id: uid(), name: `${I18n.t('Signature')} ${list.length + 1}`, html: '' }];
      // The first one an identity has is its default; after that, adding one
      // must not silently move the default off the signature already in use.
      if (!id.defaultSignatureId) id.defaultSignatureId = id.signatures[0].id;
      renderIdentities();
    }));
    body().querySelectorAll('.sig-del').forEach((b) => b.addEventListener('click', async () => {
      const id = identities[+b.dataset.i];
      const sig = sigsOf(id)[+b.dataset.j];
      if (!await Dialog.confirm(
        `${I18n.t('Remove this signature?')} "${sig?.name || ''}"`,
        { title: I18n.t('Remove'), okLabel: I18n.t('Remove'), danger: true })) return;
      collectIdentities();
      identities[+b.dataset.i].signatures = sigsOf(identities[+b.dataset.i]).filter((_, j) => j !== +b.dataset.j);
      renderIdentities();
    }));

    wireSignatureEditors();
  }

  function collectIdentities() {
    identities = identities.map((id, i) => {
      const g = (x) => document.getElementById(`id-${x}-${i}`);
      if (!g('name')) return id; // this card isn't in the current DOM at all
      return {
        ...id,
        name: g('name').value, email: g('email').value, replyTo: g('replyto').value,
        // These live behind the expand toggle (see identityCard) — when
        // collapsed they're simply not in the DOM, so keep whatever was
        // already stored instead of overwriting with nothing.
        organization: g('org')?.value ?? id.organization,
        ...collectSignatures(id, i),
        signatureOn: g('sigon')?.value ?? id.signatureOn,
        signatureDelimiter: g('sigdelim') ? g('sigdelim').checked : (id.signatureDelimiter ?? true),
        accountId: g('acct') ? g('acct').value : id.accountId,
        default: document.getElementById(`id-def-${i}`)?.checked ?? id.default,
      };
    });
    if (identities.length && !identities.some((x) => x.default)) identities[0].default = true;
  }

  /** The signature half of one identity, read back out of the DOM.
   *
   * Returns nothing at all when the card is collapsed — its signature editors
   * are then not in the document, and spreading `{signatures: []}` over the
   * identity would delete every one of them for the crime of not being on
   * screen. Same reasoning as the `?? id.organization` fallbacks above, which
   * is why this sits with them. */
  function collectSignatures(id, i) {
    const blocks = [...body().querySelectorAll(`.sig-block[data-i="${i}"]`)];
    if (!blocks.length) return {};
    const existing = sigsOf(id);
    let defaultSignatureId = null;
    const signatures = blocks.map((b, j) => {
      const sig = {
        id: existing[j]?.id || uid(),
        name: document.getElementById(`id-signame-${i}-${j}`)?.value || '',
        html: document.getElementById(`id-sig-${i}-${j}`)?.value || '',
      };
      if (document.getElementById(`id-sigdef-${i}-${j}`)?.checked) defaultSignatureId = sig.id;
      return sig;
    });
    // The server repairs a dangling default anyway (normalizeIdentities), but
    // sending the one the radio actually shows keeps the round trip honest.
    return { signatures, defaultSignatureId: defaultSignatureId || signatures[0]?.id || null };
  }

  /* ---------- filters ---------- */
  // Two levels, both inside this tab: a LIST of every filter (grouped by the
  // account it runs for, in the sidebar's account order, then by name), and an
  // EDITOR for one filter, reached by clicking it. Before this the whole tab
  // was one long stack of fully-expanded filter cards, which stopped being
  // readable at about three filters.
  //
  // Each filter can be scoped to one specific mail account (accountId) or
  // left as "All accounts" (null — the rule runs independently against
  // every account's own inbox). A move/copy action's folder dropdown is
  // sourced from filterFolderCache, populated per-account via API.folders()
  // — NOT from app.js's `state.folders`, which only ever holds whatever
  // folder tree the sidebar currently happens to be showing (and is emptied
  // out entirely in the "All inboxes" unified view), which is what made the
  // dropdown look permanently empty here before.

  const RULE_FIELDS = [['subject', 'Subject'], ['from', 'From'], ['to', 'To'], ['content', 'Content'], ['size', 'Size (KB)'], ['date', 'Date']];
  const RULE_OPS = [['contains', 'contains'], ['notContains', 'does not contain'], ['is', 'is exactly'], ['greater', 'greater than'], ['less', 'less than']];
  const ACTION_TYPES = [['move', 'Move to folder'], ['copy', 'Copy to folder'], ['redirect', 'Redirect to address'], ['reply', 'Reply with message'], ['markRead', 'Mark as read'], ['markUnread', 'Mark as unread'], ['star', 'Star'], ['delete', 'Delete']];

  let filtersView = 'list'; // 'list' | 'edit'
  let editingFilterId = null;
  // The filter exactly as the editor opened it, so leaving can tell "nothing
  // was touched" from "there are changes to save or throw away" — and, for a
  // filter created by + Add filter, so that backing out leaves nothing behind
  // at all rather than a stray "New filter" row in the list.
  let editorPristine = null;
  let editorIsNew = false;
  // Restored after coming back from the editor — body().innerHTML is rebuilt
  // from scratch, so a long list would otherwise jump back to the top (same
  // reason accountsListScrollTop exists).
  let filtersListScrollTop = 0;
  // A leaveFilterEditor() is already deciding (its prompt is up) — a second
  // press, easy with the hardware back key, must not stack a second prompt.
  let leavingEditor = false;
  // Stable serialisation of what the server is known to hold, so the list can
  // say when something is still only in this dialog. Key order is fixed here
  // deliberately: JSON.stringify of a server object and of one collectFilters()
  // just built would otherwise differ on key order alone and read as "unsaved".
  let savedFiltersKey = '[]';

  let filterFolderCache = {}; // accountId -> folders[]
  let filterFoldersLoaded = false;

  function filtersKey(list) {
    return JSON.stringify((list || []).map((f) => ({
      id: f.id, name: f.name || '', enabled: !!f.enabled, match: f.match || 'all', accountId: f.accountId || null,
      rules: (f.rules || []).map((r) => ({ field: r.field, op: r.op, value: r.value ?? '' })),
      actions: (f.actions || []).map((a) => ({ type: a.type, value: a.value ?? '' })),
    })));
  }
  const filtersDirty = () => filtersKey(filters) !== savedFiltersKey;

  /** Folder trees for every account, for the editor's move/copy dropdowns.
   * Once per Settings session: the list view doesn't need them at all, and
   * bouncing between list and editor shouldn't re-fetch every account's
   * folder tree each time. */
  async function loadFilterFolders() {
    if (filterFoldersLoaded) return;
    filterFolderCache = {};
    await Promise.all(state.accounts.map(async (a) => {
      try { filterFolderCache[a.id] = await API.folders(a.id); } catch { filterFolderCache[a.id] = []; }
    }));
    filterFoldersLoaded = true;
  }

  function defaultFilterAccountId() {
    return (state.currentAccount !== 'all' ? state.currentAccount : allAccounts()[0]?.id) || null;
  }

  function folderOptions(value, accountId) {
    // `system` folders are Hmelj's own machinery (server/index.js) — today the
    // Snoozed folder. A rule that filed mail into it would move the message
    // with nothing recorded to bring it back, which is the one way to strand
    // something in there permanently. An EXISTING target is still carried by
    // the `missing` branch below, so a rule somebody already saved keeps
    // showing what it does rather than silently retargeting itself.
    const folders = (filterFolderCache[accountId] || []).filter((f) => !f.system);
    /* value="" on every option is load-bearing, not decoration. Without it an
       option's value IS its text — and i18n.js's observer translates text
       nodes, "INBOX" among them (it's a catalogue key: Prejeto / Inbox). So
       the moment the observer ran, a move-to-INBOX action read back as
       move-to-"Prejeto": a filter that looked untouched came back changed,
       and saving it wrote a folder path that doesn't exist. */
    const known = folders.some((f) => f.path === value);
    // A target that isn't in this account's tree (a folder since renamed or
    // deleted, or one typed in another client) is carried as its own option
    // rather than left unmatched — an unmatched <select> silently reports the
    // FIRST option instead, quietly retargeting the filter on the next save.
    const missing = value && !known ? `<option value="${escAttr(value)}" selected>${esc(value)}</option>` : '';
    return `<select class="fa-value-folder">` + missing + folders.map((f) =>
      `<option value="${escAttr(f.path)}" ${f.path === value ? 'selected' : ''}>${esc(f.path)}</option>`).join('') + '</select>';
  }

  /** The list, grouped: "All accounts" filters first (they run for every
   * account), then one group per account in the sidebar's own order, then any
   * filter whose account has since been removed. Within a group, by name. */
  function filterGroups() {
    const accounts = allAccounts();
    const known = new Set(accounts.map((a) => a.id));
    const groups = [];
    const global = filters.filter((f) => !f.accountId);
    if (global.length) groups.push({ label: I18n.t('All accounts'), color: '', email: '', items: global });
    for (const a of accounts) {
      const items = filters.filter((f) => f.accountId === a.id);
      if (items.length) groups.push({ label: a.label, color: a.color, email: a.email, items });
    }
    const orphans = filters.filter((f) => f.accountId && !known.has(f.accountId));
    if (orphans.length) groups.push({ label: I18n.t('Account no longer exists'), color: '', email: '', items: orphans });
    return groups;
  }

  /** Rebuilds `filters` from what is on screen, after a drag or a keyboard
   * move. Group order is fixed (all-accounts, then accounts, then orphans),
   * so document order IS the array order — which is the order the server runs
   * them in, and the whole point of being able to arrange them by hand. */
  function readFilterOrderFromDom() {
    const byId = new Map(filters.map((f) => [f.id, f]));
    const seen = [...body().querySelectorAll('.f-row')].map((el) => byId.get(el.dataset.fid)).filter(Boolean);
    // Anything not on screen (there is nothing today, but a future filtered
    // view must not silently drop rows) keeps its place at the end.
    const shown = new Set(seen.map((f) => f.id));
    filters = [...seen, ...filters.filter((f) => !shown.has(f.id))];
    markFiltersDirty();
  }

  /** Refreshes the list's "not saved yet" marker without re-rendering — a
   * re-render mid-drag would pull the row out from under the pointer. */
  function markFiltersDirty() {
    const mark = body().querySelector('.f-dirty');
    if (mark) mark.textContent = filtersDirty() ? I18n.t('Not saved yet') : '';
  }

  function filterRow(f) {
    return `<div class="card f-row" data-fid="${escAttr(f.id)}" tabindex="0">
      <div class="row">
        <span class="f-drag" title="${escAttr(I18n.t('Drag to reorder (or Alt with the arrow keys)'))}"
              aria-label="${escAttr(I18n.t('Drag to reorder (or Alt with the arrow keys)'))}">⠿</span>
        <!-- data-no-i18n: a filter's name is the user's own text, and it now
             lives in a text node rather than an <input value> — without this
             one called "Delete" or "Star" would be run through the catalogue
             and come back translated (see i18n.js's SKIP_SELECTOR). -->
        <b class="grow" data-no-i18n>${esc(f.name || I18n.t('New filter'))}</b>
        ${f.enabled ? '' : `<span class="set-hint" style="margin:0">${I18n.t('Disabled')}</span>`}
        <span class="spacer"></span>
        <button class="btn-sm f-edit">${I18n.t('Edit')}</button>
        <button class="btn-sm danger f-del">${I18n.t('Remove')}</button>
      </div>
    </div>`;
  }

  async function renderFiltersList() {
    // Same defect as Identities above: a filter carries the account it runs
    // against, and defaultFilterAccountId() is null with none, so "+ Add filter"
    // produced a rule that could never run.
    if (!state.accounts.length) {
      body().innerHTML = `<p class="set-hint" style="grid-column:auto">${esc(I18n.t('No mail accounts yet — a filter needs an account to run against.'))}</p>`;
      return;
    }
    const groups = filterGroups();
    body().innerHTML = `
      ${groups.map((g) => `
        <div class="id-group">
          <div class="id-group-header">
            ${g.color ? `<span class="acct-dot" style="background:${escAttr(g.color)}"></span>` : ''}
            <b data-no-i18n>${esc(g.label)}</b>
            ${g.email ? `<span class="set-hint" style="margin:0" data-no-i18n>${esc(g.email)}</span>` : ''}
          </div>
          <div class="card-list">${g.items.map(filterRow).join('')}</div>
        </div>`).join('')}
      ${groups.length ? '' : `<p class="set-hint" style="grid-column:auto">${I18n.t('No filters yet.')}</p>`}
      <p style="margin:6px 0 0"><button class="link-btn" id="f-add">+ Add filter</button></p>
      <p class="set-hint f-hint">Filters run automatically in the background as new mail arrives, and on demand via "Run filters" in the sidebar. "Run filters when opening Inbox" (General) additionally re-applies them to your whole Inbox every time you open it.</p>
      <p class="set-hint f-hint">Within one account they run top to bottom in the order shown here, and the first one that moves or deletes a message stops the rest for that message. Drag ⠿ to arrange them; filters set to "All accounts" run before the account's own.</p>
      <div class="f-footer">
        <span class="set-hint f-dirty" style="margin:0">${filtersDirty() ? I18n.t('Not saved yet') : ''}</span>
        <button class="send-btn" id="f-save-all">${I18n.t('Save filters')}</button>
      </div>`;
    body().scrollTop = filtersListScrollTop;
    bindFiltersList();
  }

  function openFilterEditor(fid, { isNew = false } = {}) {
    filtersListScrollTop = body().scrollTop;
    editingFilterId = fid;
    editorPristine = structuredClone(filters.find((f) => f.id === fid) || null);
    editorIsNew = isNew;
    filtersView = 'edit';
    return renderFilters();
  }

  /** Puts the open filter back the way the editor found it — for one created
   * by + Add filter that means removing it, since "the way it was found" is
   * "not there". */
  function revertOpenFilter() {
    if (editorIsNew) filters = filters.filter((f) => f.id !== editingFilterId);
    else if (editorPristine) {
      const i = filters.findIndex((f) => f.id === editingFilterId);
      if (i >= 0) filters[i] = structuredClone(editorPristine);
    }
  }

  function closeFilterEditor() {
    editorPristine = null;
    editorIsNew = false;
    editingFilterId = null;
    filtersView = 'list';
    return renderFilters();
  }

  /** The ← Back button, and the hardware back key. Nothing typed? Just leave —
   * in particular a filter added and immediately backed out of is dropped, not
   * left sitting in the list. Otherwise ask, the same three-way compose uses
   * when it closes on an unsaved draft: throw the changes away, save them, or
   * (Cancel/Escape/back) carry on editing. */
  async function leaveFilterEditor() {
    if (leavingEditor) return;
    leavingEditor = true;
    try {
      collectFilters();
      const current = filters.find((f) => f.id === editingFilterId);
      // Nothing to compare (the filter went away underneath the editor) — just leave.
      if (!current || !editorPristine) { await closeFilterEditor(); return; }
      if (filtersKey([current]) === filtersKey([editorPristine])) { revertOpenFilter(); await closeFilterEditor(); return; }
      const choice = await Dialog.choose(I18n.t('Save your changes to this filter before going back?'), {
        title: I18n.t('Unsaved changes'),
        buttons: [
          { label: I18n.t('Discard'), value: 'discard', danger: true },
          { label: I18n.t('Save'), value: 'save', primary: true },
        ],
      });
      if (!choice) return; // Cancel / Escape / back key — stay in the editor
      if (choice === 'save') {
        // A failed save has already said why; staying put keeps the changes
        // on screen to retry rather than throwing them away on the user's behalf.
        if (await saveFiltersNow()) await closeFilterEditor();
        return;
      }
      revertOpenFilter();
      await closeFilterEditor();
    } finally {
      leavingEditor = false;
    }
  }

  /** Moves a row one place within its own account group and keeps the focus
   * on it. Groups are never crossed: a filter's account is a property of the
   * filter, changed in its editor, not something a drag should silently
   * rewrite. */
  function moveFilterRow(row, dir) {
    const sibling = dir < 0 ? row.previousElementSibling : row.nextElementSibling;
    if (!sibling) return false;
    row.parentElement.insertBefore(dir < 0 ? row : sibling, dir < 0 ? sibling : row);
    readFilterOrderFromDom();
    row.focus();
    return true;
  }

  /* Drag-to-reorder, on a handle rather than the whole row: the row itself is
     a button that opens the filter, and on a phone a draggable row would eat
     the scroll. Pointer events (not the HTML5 drag-and-drop API, which touch
     browsers don't fire at all) so mouse, pen and finger all work the same. */
  let filterDrag = null; // {row, id, startY, y, moved, raf} while one is in progress
  const DRAG_EDGE = 56;  // px from the list's edge where it starts scrolling itself
  const DRAG_SPEED = 16; // px per frame at the very edge, tapering to 0 at DRAG_EDGE

  function bindFilterDrag(row) {
    const handle = row.querySelector('.f-drag');
    if (!handle) return;
    handle.addEventListener('pointerdown', (e) => {
      if (filterDrag || (e.button != null && e.button !== 0)) return;
      // Stops the text selection a mouse drag would otherwise start, and the
      // long-press callout on touch.
      e.preventDefault();
      filterDrag = { row, id: e.pointerId, startY: e.clientY, y: e.clientY, moved: false, raf: 0 };
      row.classList.add('dragging');
      /* Bound to `document`, NOT to the handle: the swap below MOVES the row
         in the DOM, and moving an element releases the pointer capture it
         holds (touch's implicit capture included) — a handle-bound listener
         stops hearing about the drag the moment the first swap happens, which
         is exactly why a drag used to manage one place and then die. From
         `document` the events arrive whether capture survived or not. */
      document.addEventListener('pointermove', onFilterDragMove);
      document.addEventListener('pointerup', endFilterDrag);
      document.addEventListener('pointercancel', endFilterDrag);
      // Alt-tabbing mid-drag can swallow the pointerup, which would leave the
      // auto-scroll's animation loop running for the life of the page.
      window.addEventListener('blur', endFilterDrag);
      filterDrag.raf = requestAnimationFrame(filterDragScroll);
    });
  }

  function onFilterDragMove(e) {
    if (!filterDrag || e.pointerId !== filterDrag.id) return;
    e.preventDefault();
    if (Math.abs(e.clientY - filterDrag.startY) > 3) filterDrag.moved = true;
    filterDrag.y = e.clientY;
    dragFilterTo(e.clientY);
  }

  /** Draws the row at the pointer and swaps it with whichever neighbour it has
   * moved past. Also driven by the auto-scroll below, where the list moves
   * under a finger that is holding still. */
  function dragFilterTo(clientY) {
    const { row } = filterDrag;
    row.style.transform = `translateY(${clientY - filterDrag.startY}px)`;
    const mid = row.getBoundingClientRect().top + row.offsetHeight / 2;
    for (const other of [...row.parentElement.children]) {
      if (other === row) continue;
      const r = other.getBoundingClientRect();
      // Which side the neighbour is on decides which way past its middle
      // counts: dragging DOWN swaps once the row's midpoint is past the
      // middle of the row below, dragging up, the mirror of that. Equality
      // counts as past (a drag of exactly one row's height has plainly
      // swapped), and the two tests being exact mirrors is what stops a row
      // that just moved from immediately moving back.
      const below = !!(row.compareDocumentPosition(other) & Node.DOCUMENT_POSITION_FOLLOWING);
      if (below ? mid < r.top + r.height / 2 : mid > r.top + r.height / 2) continue;
      // Reordering moves the row's resting place, so the offset it is drawn
      // at has to be re-based by exactly that much or it jumps under the
      // finger. Measure without the transform, move, measure again.
      row.style.transform = '';
      const was = row.getBoundingClientRect().top;
      row.parentElement.insertBefore(row, below ? other.nextElementSibling : other);
      filterDrag.startY += row.getBoundingClientRect().top - was;
      row.style.transform = `translateY(${clientY - filterDrag.startY}px)`;
      break;
    }
  }

  /** Scrolls the list when the pointer is held near its top or bottom edge, so
   * a filter can be dragged somewhere that isn't on screen when the drag
   * starts — on a phone that is most of the list. */
  function filterDragScroll() {
    if (!filterDrag) return;
    const el = body();
    const box = el.getBoundingClientRect();
    const y = filterDrag.y;
    let step = 0;
    if (y < box.top + DRAG_EDGE) step = -DRAG_SPEED * Math.min(1, (box.top + DRAG_EDGE - y) / DRAG_EDGE);
    else if (y > box.bottom - DRAG_EDGE) step = DRAG_SPEED * Math.min(1, (y - box.bottom + DRAG_EDGE) / DRAG_EDGE);
    if (step) {
      const was = el.scrollTop;
      el.scrollTop = was + step;
      const scrolled = el.scrollTop - was; // 0 once it hits either end
      if (scrolled) {
        // The list moved under a stationary finger: the row's resting place
        // shifted by exactly that much, so re-base or it slides away from the
        // finger — and re-run the crossing test, since no pointermove will.
        filterDrag.startY -= scrolled;
        filterDrag.moved = true;
        dragFilterTo(filterDrag.y);
      }
    }
    filterDrag.raf = requestAnimationFrame(filterDragScroll);
  }

  function endFilterDrag(e) {
    // `blur` has no pointerId at all and always ends the drag; a pointer event
    // only ends the drag it belongs to (a second finger elsewhere does not).
    if (!filterDrag || (e && 'pointerId' in e && e.pointerId !== filterDrag.id)) return;
    const { row, moved, raf } = filterDrag;
    cancelAnimationFrame(raf);
    filterDrag = null;
    document.removeEventListener('pointermove', onFilterDragMove);
    document.removeEventListener('pointerup', endFilterDrag);
    document.removeEventListener('pointercancel', endFilterDrag);
    window.removeEventListener('blur', endFilterDrag);
    row.classList.remove('dragging');
    row.style.transform = '';
    // The list was re-rendered underneath the drag — nothing to read back.
    if (!moved || !row.isConnected) return;
    readFilterOrderFromDom();
    // A mouse-up over the row it started on still produces a click, on the
    // row rather than the handle — which would open the filter that was
    // just dragged. Swallow that one click.
    const swallow = (ev) => { ev.stopPropagation(); ev.preventDefault(); };
    body().addEventListener('click', swallow, { capture: true, once: true });
    setTimeout(() => body().removeEventListener('click', swallow, { capture: true }), 0);
  }

  function bindFiltersList() {
    const openEditor = (fid) => openFilterEditor(fid);
    body().querySelectorAll('.f-row').forEach((row) => {
      // The whole row opens the filter — the Edit button is there to make that
      // discoverable, not because it's the only way in.
      row.addEventListener('click', (e) => {
        if (e.target.closest('.f-del') || e.target.closest('.f-drag')) return;
        openEditor(row.dataset.fid);
      });
      row.addEventListener('keydown', (e) => {
        // Alt+↑/↓ moves the filter instead of opening it — the keyboard (and
        // screen-reader) equivalent of dragging the handle. Plain arrows are
        // left alone: they scroll the list.
        if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
          e.preventDefault();
          moveFilterRow(row, e.key === 'ArrowUp' ? -1 : 1);
          return;
        }
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openEditor(row.dataset.fid); }
      });
      bindFilterDrag(row);
    });
    body().querySelectorAll('.f-del').forEach((b) => b.addEventListener('click', async (e) => {
      e.stopPropagation();
      const fid = b.closest('[data-fid]').dataset.fid;
      if (!await Dialog.confirm(I18n.t('Delete this filter?'), { title: I18n.t('Delete'), okLabel: I18n.t('Delete'), danger: true })) return;
      filters = filters.filter((f) => f.id !== fid);
      renderFilters();
    }));
    document.getElementById('f-add')?.addEventListener('click', () => {
      const f = {
        id: uid(), name: I18n.t('New filter'), enabled: true, match: 'all', accountId: defaultFilterAccountId(),
        rules: [{ field: 'subject', op: 'contains', value: '' }], actions: [{ type: 'move', value: 'INBOX' }],
      };
      filters.push(f);
      openFilterEditor(f.id, { isNew: true });
    });
    document.getElementById('f-save-all')?.addEventListener('click', (e) => saveFiltersNow(e.currentTarget));
  }

  /** Saves filters on their own, without closing the dialog — the whole point
   * of the buttons on this tab (adding several filters in a row used to mean
   * pressing the dialog's Save each time, which closes it). The API takes the
   * whole list, so this writes every filter, not just the open one; the
   * dialog-wide Save still does the same thing along with everything else. */
  async function saveFiltersNow(btn) {
    collectFilters();
    if (btn) btn.disabled = true;
    try {
      const saved = await API.saveFilters(filters);
      if (Array.isArray(saved)) filters = saved;
      savedFiltersKey = filtersKey(filters);
      // The list stays on screen after its own Save press (only the editor's
      // Save navigates), so clear its "not saved yet" marker in place rather
      // than re-rendering the whole list and losing the scroll position.
      const mark = body().querySelector('.f-dirty');
      if (mark) mark.textContent = '';
      toast(I18n.t('Filters saved') + ' ✓');
      return true;
    } catch (e) {
      toast(I18n.t('Save failed: ') + e.message);
      return false;
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  function filterEditor(f) {
    const accountId = f.accountId || defaultFilterAccountId();
    return `<div class="f-editor-bar">
        <button class="link-btn" id="f-back">← ${I18n.t('Back to filters')}</button>
        <span class="spacer"></span>
        <button class="send-btn" id="f-save">${I18n.t('Save filter')}</button>
      </div>
      <div class="card" data-fid="${escAttr(f.id)}">
      <div class="row">
        <input class="f-name grow" value="${escAttr(f.name)}" placeholder="Filter name">
        <label class="mini-toggle"><input type="checkbox" class="f-enabled" ${f.enabled ? 'checked' : ''}> Enabled</label>
        ${sel('', [['all', 'All rules must match'], ['any', 'At least one rule matches'], ['always', 'All messages']], f.match).replace('<select', '<select class="f-match"')}
        ${sel('', [['', I18n.t('All accounts')], ...allAccounts().map((a) => [a.id, a.label])], f.accountId || '').replace('<select', `<select class="f-account" title="${I18n.t('Account')}"`)}
      </div>
      <div><label>Rules</label>
        <div class="f-rules">${(f.rules || []).map((r) => ruleRow(r)).join('')}</div>
        <button class="link-btn f-add-rule">+ rule</button>
      </div>
      <div><label>Actions</label>
        <div class="f-actions">${(f.actions || []).map((a) => actionRow(a, accountId)).join('')}</div>
        <button class="link-btn f-add-action">+ action</button>
      </div>
    </div>`;
  }

  function ruleRow(r = { field: 'subject', op: 'contains', value: '' }) {
    return `<div class="rule-row">
      ${sel('', RULE_FIELDS, r.field).replace('<select', '<select class="fr-field"')}
      ${sel('', RULE_OPS, r.op).replace('<select', '<select class="fr-op"')}
      <input class="fr-value grow" value="${escAttr(r.value)}" placeholder="value">
      <button class="link-btn fr-del">✕</button>
    </div>`;
  }

  function actionRow(a = { type: 'move', value: 'INBOX' }, accountId) {
    const needsFolder = a.type === 'move' || a.type === 'copy';
    const needsText = a.type === 'redirect' || a.type === 'reply';
    return `<div class="action-row">
      ${sel('', ACTION_TYPES, a.type).replace('<select', '<select class="fa-type"')}
      ${needsFolder ? folderOptions(a.value, accountId) : needsText ? `<input class="fa-value grow" value="${escAttr(a.value || '')}" placeholder="${a.type === 'redirect' ? 'address@example.com' : 'reply text'}">` : ''}
      <button class="link-btn fa-del">✕</button>
    </div>`;
  }

  async function renderFilterEditor() {
    const f = filters.find((x) => x.id === editingFilterId);
    // The filter went away underneath us (removed in another tab of this same
    // dialog, or an accounts change that dropped it) — fall back to the list
    // rather than rendering an editor for nothing.
    if (!f) return closeFilterEditor();
    body().innerHTML = `<p class="set-hint" style="grid-column:auto">${I18n.t('Loading…')}</p>`;
    await loadFilterFolders();
    body().innerHTML = filterEditor(f);
    // Opened from a click far down a long list, the editor would otherwise
    // inherit that scroll position and open somewhere in its middle.
    body().scrollTop = 0;
    const name = body().querySelector('.f-name');
    // Not on a phone: focusing a text field there throws the on-screen
    // keyboard over the form the moment it opens, before anyone asked to type.
    if (name && !isMobileViewport()) {
      name.focus();
      // A brand-new filter is called "New filter" — select it so the first
      // keystroke replaces the placeholder instead of appending to it.
      if (editorIsNew) name.select();
    }
    bindFilterEditor();
  }

  function renderFilters() {
    return filtersView === 'edit' ? renderFilterEditor() : renderFiltersList();
  }

  function bindFilterEditor() {
    document.getElementById('f-back').addEventListener('click', leaveFilterEditor);
    document.getElementById('f-save').addEventListener('click', async (e) => {
      if (await saveFiltersNow(e.currentTarget)) await closeFilterEditor();
    });
    body().querySelectorAll('.f-add-rule').forEach((b) => b.addEventListener('click', () => {
      b.previousElementSibling.insertAdjacentHTML('beforeend', ruleRow()); bindRowDeletes();
    }));
    body().querySelectorAll('.f-add-action').forEach((b) => b.addEventListener('click', () => {
      const accountId = b.closest('[data-fid]').querySelector('.f-account').value || defaultFilterAccountId();
      b.previousElementSibling.insertAdjacentHTML('beforeend', actionRow(undefined, accountId)); bindRowDeletes(); bindActionTypeSwaps();
    }));
    // Switching a filter's account swaps its move/copy dropdowns to that
    // account's own folder list (each row's current type/value is preserved
    // where possible — the value itself may no longer exist in the new
    // account's tree, which is fine, it just shows as unselected).
    body().querySelectorAll('.f-account').forEach((s) => (s.onchange = () => {
      const card = s.closest('[data-fid]');
      const accountId = s.value || defaultFilterAccountId();
      card.querySelectorAll('.action-row').forEach((row) => {
        const type = row.querySelector('.fa-type').value;
        let value = row.querySelector('.fa-value-folder')?.value ?? row.querySelector('.fa-value')?.value ?? '';
        // A folder target is dropped when the new account has no such path:
        // folderOptions() otherwise carries an unknown target through as its
        // own option (so a stored one is never silently retargeted), which is
        // exactly wrong here — moving to the OTHER account's folder is what
        // switching accounts is meant to get away from. Pick again.
        if (row.querySelector('.fa-value-folder') && !(filterFolderCache[accountId] || []).some((f) => f.path === value)) value = '';
        row.outerHTML = actionRow({ type, value }, accountId);
      });
      bindRowDeletes(); bindActionTypeSwaps();
    }));
    bindRowDeletes();
    bindActionTypeSwaps();
  }
  function bindRowDeletes() {
    body().querySelectorAll('.fr-del, .fa-del').forEach((b) => (b.onclick = () => b.parentElement.remove()));
  }
  function bindActionTypeSwaps() {
    body().querySelectorAll('.fa-type').forEach((s) => (s.onchange = () => {
      const row = s.parentElement;
      const accountId = row.closest('[data-fid]').querySelector('.f-account').value || defaultFilterAccountId();
      row.outerHTML = actionRow({ type: s.value, value: '' }, accountId);
      bindRowDeletes(); bindActionTypeSwaps();
    }));
  }

  /** Reads the open editor back into `filters`. A no-op on the list view,
   * which has nothing to read — including when the dialog-wide Save calls it
   * (collectCurrentTab). */
  function collectFilters() {
    if (filtersView !== 'edit') return;
    const card = body().querySelector('.card[data-fid]');
    if (!card) return;
    const i = filters.findIndex((f) => f.id === card.dataset.fid);
    if (i < 0) return;
    filters[i] = {
      ...filters[i],
      name: card.querySelector('.f-name').value,
      enabled: card.querySelector('.f-enabled').checked,
      match: card.querySelector('.f-match').value,
      accountId: card.querySelector('.f-account').value || null,
      rules: [...card.querySelectorAll('.rule-row')].map((r) => ({
        field: r.querySelector('.fr-field').value,
        op: r.querySelector('.fr-op').value,
        value: r.querySelector('.fr-value').value,
      })),
      actions: [...card.querySelectorAll('.action-row')].map((r) => ({
        type: r.querySelector('.fa-type').value,
        value: r.querySelector('.fa-value-folder')?.value ?? r.querySelector('.fa-value')?.value ?? '',
      })),
    };
  }

  /* ---------- subject (Settings > Subject) ----------
   *
   * Rewrites the subject SHOWN in the message list and in push notifications,
   * per account. server/subjectRules.js owns the engine and the reasoning; the
   * two things worth repeating where the buttons are:
   *
   *   - it is DISPLAY ONLY. Nothing on the mail server changes, the cache keeps
   *     the real subject (so search still matches what the sender wrote), and
   *     opening a message shows it in full. That is deliberate, and it is what
   *     the hint at the top of the tab says.
   *   - rules CHAIN, top to bottom, each working on the previous one's output.
   *     Which is why order is editable, and why saving is all-or-nothing (the
   *     server refuses a list with a bad rule in it rather than storing half a
   *     chain).
   *
   * Deliberately one flat view with no separate editor page, unlike Filters: a
   * rule is six fields, and a round trip through an editor to change "U-" to
   * "N-" would cost more than it explains. Order is moved with buttons rather
   * than the Filters tab's drag handle — that is ~120 lines of tuned pointer
   * handling wired to .f-drag, and generalising it to earn a second user would
   * put a working interaction at risk for a list that holds a handful of rows.
   */

  let subjectRules = [];
  let savedSubjectKey = '[]';
  // A rule list grows past the point where reading it as a wall of open cards
  // works, so a rule is one line until you open it. Ids, not indices — the list
  // is reordered and filtered under this.
  const subjectExpanded = new Set();
  // Filter text for the rule list. Kept here rather than read off the input so
  // it survives the re-renders that adding, removing and moving a rule cause.
  let subjectSearch = '';
  // What the Test panel is currently trying, kept across re-renders so typing a
  // subject and then toggling a rule doesn't empty the box you were testing in.
  let subjectTest = { subject: '', accountId: null, result: null, steps: [], timer: null };

  const subjectKey = (list) => JSON.stringify(list);
  const subjectDirty = () => subjectKey(subjectRules) !== savedSubjectKey;

  function newSubjectRule() {
    return {
      id: uid(), name: '', enabled: true, accountIds: [],
      mode: 'text', find: '', replace: '', ignoreCase: false, all: false,
    };
  }

  /** Refreshes the "not saved yet" marker without re-rendering — the same
   * reasoning as markFiltersDirty: a re-render on every keystroke would take
   * the focus out of the field being typed in. */
  function markSubjectDirty() {
    const mark = body().querySelector('.sr-dirty');
    if (mark) mark.textContent = subjectDirty() ? I18n.t('Not saved yet') : '';
  }

  /** Why a rule's pattern can't run, or '' if it's fine. Mirrors
   * server/subjectRules.js#compile — the server is still the authority (it also
   * refuses patterns that are merely too SLOW, which cannot be measured here),
   * this just says so immediately instead of at save time. */
  function subjectRuleError(r) {
    if (!r.find) return '';
    if (r.mode !== 'regex') return '';
    try { new RegExp(r.find); return ''; } catch (e) { return e.message; }
  }

  /**
   * A rule that is plainly MEANT as a regular expression but is set to Plain
   * text — which fails by doing nothing at all, silently, on every message.
   *
   * Two signals, both strong enough to stand alone:
   *   - `$1` in the replacement. Plain text has no capture groups, so there is
   *     nothing for it to refer to; it can only be a leftover from a pattern.
   *   - a backslash in the text to find. `\d`, `\[`, `\s` are regex; nobody
   *     types a backslash into a subject line on purpose.
   *
   * Deliberately NOT "the find contains brackets": "[RESOLVED]" and
   * "[FIRING:1]" are exactly what a plain-text rule is for here, and warning
   * about those would train the warning to be ignored.
   */
  function subjectRuleModeHint(r) {
    if (r.mode === 'regex' || !r.find) return '';
    if (/\$\d/.test(r.replace || '')) return I18n.t('$1 only means something in a regular expression — this rule is set to Plain text, so it will match nothing.');
    if (/\\/.test(r.find)) return I18n.t('This looks like a regular expression, but the rule is set to Plain text — the backslashes will be matched literally.');
    return '';
  }

  /** Does this rule match the list's filter? Name, find and replace all count:
   *  a rule's name is optional in the first place, so matching names alone
   *  would make every unnamed rule unfindable — and "which rule strips
   *  [Dogodek]?" is the question actually being asked. */
  function subjectRuleMatches(r, q) {
    if (!q) return true;
    return `${r.name || ''}\n${r.find || ''}\n${r.replace || ''}`.toLowerCase().includes(q);
  }

  /** The one line a collapsed rule shows: what it looks for and what it puts
   *  there instead. Rebuilt in place as those two fields are typed (see
   *  bindSubjectRows) so the head never disagrees with the body under it. */
  function subjectRuleSummary(r) {
    return `${r.find || '…'} → ${r.replace || ''}`;
  }

  function subjectRuleCard(r, i) {
    const err = subjectRuleError(r);
    const accounts = allAccounts();
    // `all` drives two things on the account row below: each per-account box is
    // DISABLED, and its label carries `off`. The class is what actually shows
    // it — disabling an <input> greys the box and leaves the label beside it at
    // full strength, so the row read as "these are available, they just ignore
    // you". See .sr-accounts .mini-toggle.off in app.css.
    const all = !r.accountIds || !r.accountIds.length;
    const open = subjectExpanded.has(r.id);
    // Reordering is what the chain runs in, and a filtered list only shows some
    // of it — "up" past a neighbour you cannot see would look like the button
    // doing nothing. Off while filtering, and the tooltip says why.
    const filtering = !!subjectSearch;
    const moveTitle = filtering ? I18n.t('Clear the search to reorder rules') : null;
    return `<div class="card sr-row${open ? ' expanded' : ''}" data-sid="${escAttr(r.id)}">
      <div class="row sr-head">
        <button class="sr-toggle" aria-expanded="${open}" title="${escAttr(I18n.t(open ? 'Collapse' : 'Expand'))}">${open ? '▾' : '▸'}</button>
        <b class="sr-title" data-no-i18n>${esc(r.name || I18n.t('Untitled rule'))}</b>
        <span class="set-hint sr-summary" data-no-i18n>${esc(subjectRuleSummary(r))}</span>
        ${r.enabled !== false ? '' : `<span class="set-hint sr-off" style="margin:0">${I18n.t('Disabled')}</span>`}
        <span class="spacer"></span>
        <!-- data-edge marks the buttons that are disabled STRUCTURALLY (the
             first row cannot go up, the last cannot go down) as opposed to
             just because a search is on. applySubjectFilter re-enables the
             latter when the search is cleared, and must leave these alone. -->
        <button class="btn-sm sr-up" ${i === 0 ? 'data-edge="1"' : ''} title="${escAttr(moveTitle || I18n.t('Move up'))}" ${filtering || i === 0 ? 'disabled' : ''}>↑</button>
        <button class="btn-sm sr-down" ${i === subjectRules.length - 1 ? 'data-edge="1"' : ''} title="${escAttr(moveTitle || I18n.t('Move down'))}" ${filtering || i === subjectRules.length - 1 ? 'disabled' : ''}>↓</button>
        <button class="btn-sm danger sr-del">${I18n.t('Remove')}</button>
      </div>
      <div class="sr-detail">
        <div class="row">
          <label class="mini-toggle"><input type="checkbox" class="sr-enabled" ${r.enabled !== false ? 'checked' : ''}> ${I18n.t('Enabled')}</label>
          <input class="sr-name grow" value="${escAttr(r.name || '')}" placeholder="${escAttr(I18n.t('Rule name'))}">
        </div>
        <div class="row">
          ${sel('', [['text', I18n.t('Plain text')], ['regex', I18n.t('Regular expression')]], r.mode || 'text').replace('<select', `<select class="sr-mode" title="${escAttr(I18n.t('How the text to find is read'))}"`)}
          <input class="sr-find grow" value="${escAttr(r.find || '')}" placeholder="${escAttr(I18n.t('Text to find'))}" spellcheck="false">
          <span>→</span>
          <input class="sr-replace grow" value="${escAttr(r.replace || '')}" placeholder="${escAttr(I18n.t('Replace with'))}" spellcheck="false">
        </div>
        ${err ? `<div class="set-hint sr-err" data-no-i18n>${esc(err)}</div>` : ''}
        ${!err && subjectRuleModeHint(r) ? `<div class="set-hint sr-warn">${esc(subjectRuleModeHint(r))}</div>` : ''}
        <div class="row">
          <label class="mini-toggle"><input type="checkbox" class="sr-ci" ${r.ignoreCase ? 'checked' : ''}> ${I18n.t('Ignore case')}</label>
          <label class="mini-toggle"><input type="checkbox" class="sr-all" ${r.all ? 'checked' : ''}> ${I18n.t('Replace every occurrence')}</label>
        </div>
        <div class="row sr-accounts">
          <label>${I18n.t('Applies to')}</label>
          <label class="mini-toggle"><input type="checkbox" class="sr-acct-all" ${all ? 'checked' : ''}> ${I18n.t('All accounts')}</label>
          ${accounts.map((a) => `<label class="mini-toggle${all ? ' off' : ''}" data-no-i18n${
            all ? ` title="${escAttr(I18n.t('Turn off "All accounts" to pick individual ones'))}"` : ''
          }><input type="checkbox" class="sr-acct" value="${escAttr(a.id)}" ${!all && r.accountIds.includes(a.id) ? 'checked' : ''} ${all ? 'disabled' : ''}> ${esc(a.label)}</label>`).join('')}
        </div>
      </div>
    </div>`;
  }

  /**
   * Hides the rules that don't match the filter, and updates the "n of m" count
   * with them.
   *
   * Deliberately a DOM pass rather than a re-render: this runs on every
   * keystroke in the search box, and re-rendering would take the cursor out of
   * the very field being typed in. The same reasoning as markSubjectDirty.
   */
  function applySubjectFilter() {
    const q = subjectSearch.trim().toLowerCase();
    const byId = new Map(subjectRules.map((r) => [r.id, r]));
    let shown = 0;
    for (const card of body().querySelectorAll('.sr-row')) {
      const r = byId.get(card.dataset.sid);
      const match = !r || subjectRuleMatches(r, q);
      card.hidden = !match;
      if (match) shown++;
    }
    const count = body().querySelector('.sr-count');
    if (count) count.textContent = q ? `${shown} / ${subjectRules.length}` : '';
    // Reordering is disabled while filtering (see subjectRuleCard) — but the
    // filter changes WITHOUT a re-render, so the buttons have to follow it from
    // here. data-edge marks the ones that are disabled for a structural reason
    // and must stay that way when the search is cleared.
    for (const b of body().querySelectorAll('.sr-up, .sr-down')) b.disabled = !!q || b.dataset.edge === '1';
    const empty = body().querySelector('.sr-none');
    if (empty) empty.hidden = !(q && shown === 0);
  }

  /* ---------- saved searches ----------
   * Rename, reorder and delete only. There is deliberately no "new saved
   * search" button here: a saved search is made from a search you have just
   * run and looked at the results of ("Save this search", under the results),
   * which is the only moment you know it asks the right question. A form here
   * would invite typing a query blind and pinning it unseen.
   */
  function savedScopeLabel(sv) {
    if (!sv.accountId) return I18n.t('All accounts');
    const a = allAccounts().find((x) => x.id === sv.accountId);
    // Named rather than silently blank when the account is gone: this pane is
    // exactly where someone comes to fix that.
    if (!a) return I18n.t('Account no longer available');
    return sv.folder ? `${a.label} · ${sv.folder}` : a.label;
  }

  function renderSaved() {
    if (!savedSearches.length) {
      body().innerHTML = `<p class="set-hint">${I18n.t('No saved searches yet. Run a search, then use "Save this search" under the results.')}</p>`;
      return;
    }
    body().innerHTML = `<div class="card-list">
      ${savedSearches.map((sv, i) => `<div class="card" data-saved="${escAttr(sv.id)}">
        <div class="row">
          <input class="sv-name" value="${escAttr(sv.name)}" style="flex:1" aria-label="${escAttr(I18n.t('Name'))}">
          <button class="btn-sm sv-up" ${i === 0 ? 'disabled' : ''} title="${escAttr(I18n.t('Move up'))}">↑</button>
          <button class="btn-sm sv-down" ${i === savedSearches.length - 1 ? 'disabled' : ''} title="${escAttr(I18n.t('Move down'))}">↓</button>
          <button class="btn-sm danger sv-del">${I18n.t('Remove')}</button>
        </div>
        <div class="row">
          <input class="sv-query" value="${escAttr(sv.query)}" style="flex:1" aria-label="${escAttr(I18n.t('Search'))}">
        </div>
        <div class="row">
          <span class="set-hint" style="margin:0">${esc(savedScopeLabel(sv))}${sv.unreadOnly ? ' · ' + I18n.t('Unread only') : ''}${sv.flaggedOnly ? ' · ' + I18n.t('Starred only') : ''}</span>
        </div>
      </div>`).join('')}
      </div>
      <p class="set-hint">${I18n.t('Saved searches run fresh every time you open one — nothing is stored except the question itself. They appear in the sidebar under your folders.')}</p>`;

    const idOf = (el) => el.closest('[data-saved]').dataset.saved;
    const at = (id) => savedSearches.findIndex((x) => x.id === id);
    // Typed edits are collected on save (collectCurrentTab), like every other
    // deferred pane; the buttons below change the LIST and so re-render, which
    // would throw away an uncommitted edit in a sibling row — hence the read-back.
    const collect = () => {
      for (const card of body().querySelectorAll('[data-saved]')) {
        const sv = savedSearches.find((x) => x.id === card.dataset.saved);
        if (!sv) continue;
        sv.name = card.querySelector('.sv-name').value;
        sv.query = card.querySelector('.sv-query').value;
      }
    };
    for (const b of body().querySelectorAll('.sv-up, .sv-down')) {
      b.addEventListener('click', () => {
        collect();
        const i = at(idOf(b));
        const j = b.classList.contains('sv-up') ? i - 1 : i + 1;
        if (j < 0 || j >= savedSearches.length) return;
        [savedSearches[i], savedSearches[j]] = [savedSearches[j], savedSearches[i]];
        renderSaved();
      });
    }
    for (const b of body().querySelectorAll('.sv-del')) {
      b.addEventListener('click', async () => {
        collect();
        const sv = savedSearches[at(idOf(b))];
        if (!await Dialog.confirm(I18n.t('Remove this saved search?') + ` "${sv.name}"`, { title: I18n.t('Remove'), okLabel: I18n.t('Remove') })) return;
        savedSearches = savedSearches.filter((x) => x.id !== sv.id);
        renderSaved();
      });
    }
  }

  /* ---------- templates ----------
   * Reusable pieces of message. Edited with the composer's own toolbar (see
   * richEditor) — a template is going INTO a message, so the options for
   * writing one are the options for writing the other. It was a bare
   * contenteditable with no toolbar at all, which meant a template could hold
   * formatting nobody could produce here.
   */
  function renderTemplates() {
    body().innerHTML = `<div class="card-list">
      ${templates.map((t, i) => `<div class="card" data-tpl="${escAttr(t.id)}">
        <div class="row">
          <input class="tpl-name" value="${escAttr(t.name)}" placeholder="${escAttr(I18n.t('Name'))}" style="flex:1" aria-label="${escAttr(I18n.t('Name'))}">
          <button class="btn-sm danger tpl-del">${I18n.t('Remove')}</button>
        </div>
        ${richEditor(`tpl-body-${i}`, t.html || '')}
      </div>`).join('')}
      </div>
      <p><button class="link-btn" id="tpl-add">+ ${I18n.t('Add template')}</button></p>
      <p class="set-hint">${I18n.t('Insert one while writing from the composer’s ⋯ menu. Templates are yours alone — they are not shared with anyone you share a mailbox with.')}</p>`;

    document.getElementById('tpl-add').addEventListener('click', () => {
      collectTemplates();
      templates.push({ id: 'new-' + Date.now(), name: '', html: '' });
      renderTemplates();
      // Straight into the new row's name field: adding one and then having to
      // find it is a step nobody wants.
      body().querySelector('[data-tpl]:last-of-type .tpl-name')?.focus();
    });
    wireSignatureEditors();
    for (const b of body().querySelectorAll('.tpl-del')) {
      b.addEventListener('click', async () => {
        collectTemplates();
        const id = b.closest('[data-tpl]').dataset.tpl;
        const t = templates.find((x) => x.id === id);
        if (t?.name && !await Dialog.confirm(I18n.t('Remove this template?') + ` "${t.name}"`, { title: I18n.t('Remove'), okLabel: I18n.t('Remove') })) return;
        templates = templates.filter((x) => x.id !== id);
        renderTemplates();
      });
    }
  }

  /** Reads the rows back into `templates`. Called before any re-render and by
   *  collectCurrentTab, for the same reason the saved-search pane does it: a
   *  re-render throws away uncommitted typing in every OTHER row. */
  function collectTemplates() {
    for (const card of body().querySelectorAll('[data-tpl]')) {
      const t = templates.find((x) => x.id === card.dataset.tpl);
      if (!t) continue;
      t.name = card.querySelector('.tpl-name').value;
      // The hidden input, not the contenteditable: richEditor's source view
      // swaps which of the two is showing, and the hidden one is the field that
      // is kept in step with whichever it is (see wireSignatureEditors).
      t.html = card.querySelector('.sig-editor input[type="hidden"]')?.value ?? t.html;
    }
  }

  function renderSubject() {
    const accounts = allAccounts();
    if (subjectTest.accountId == null) subjectTest.accountId = defaultFilterAccountId();
    body().innerHTML = `<div class="card-list">
      <p class="set-hint" style="grid-column:auto">${I18n.t('Shortens long subjects in the message list and in notifications. Nothing is changed on the mail server: search still matches the original text, and opening a message shows its real subject in full.')}</p>
      <p class="set-hint" style="grid-column:auto">${I18n.t('Rules run top to bottom, each one working on the result of the one above it, so a prefix can be stripped by one rule and a word shortened by the next. Plain text matches literally; a regular expression can use $1, $2 for whatever it captured.')}</p>
      ${subjectRules.length > 1 || subjectSearch ? `<div class="row sr-search-row">
        <input id="sr-search" class="grow" type="search" value="${escAttr(subjectSearch)}" placeholder="${escAttr(I18n.t('Search rules by name or text'))}" spellcheck="false">
        <span class="set-hint sr-count" data-no-i18n style="margin:0"></span>
        <button class="link-btn" id="sr-expand-all">${I18n.t(allSubjectRulesOpen() ? 'Collapse all' : 'Expand all')}</button>
      </div>` : ''}
      ${subjectRules.map(subjectRuleCard).join('')}
      <p class="set-hint sr-none" style="grid-column:auto" hidden>${I18n.t('No rule matches your search.')}</p>
      ${subjectRules.length ? '' : `<p class="set-hint" style="grid-column:auto">${I18n.t('No subject rules yet.')}</p>`}
      <p style="margin:6px 0 0"><button class="link-btn" id="sr-add">${I18n.t('+ Add rule')}</button></p>
      <div class="f-footer">
        <span class="set-hint sr-dirty" style="margin:0">${subjectDirty() ? I18n.t('Not saved yet') : ''}</span>
        <button class="send-btn" id="sr-save">${I18n.t('Save rules')}</button>
      </div>
      <hr class="set-divider">
      <div class="card">
        <div class="row"><b>${I18n.t('Test a subject')}</b></div>
        <p class="set-hint" style="margin:0">${I18n.t('Paste a real subject to see what the list would show. Tests the rules exactly as edited above, saved or not.')}</p>
        <div class="row">
          ${accounts.length > 1 ? sel('', accounts.map((a) => [a.id, a.label]), subjectTest.accountId).replace('<select', `<select class="sr-test-account" title="${escAttr(I18n.t('Account'))}"`) : ''}
          <input class="sr-test-input grow" value="${escAttr(subjectTest.subject)}" placeholder="${escAttr(I18n.t('Paste a subject here'))}" spellcheck="false">
        </div>
        <div id="sr-test-out"></div>
      </div>
    </div>`;
    bindSubjectRows();
    // The filter lives in a module variable, not in the DOM, so a re-render
    // (add, remove, reorder) has to re-apply it or every hidden rule comes back.
    applySubjectFilter();
    renderSubjectTestOut();
    if (subjectTest.subject) runSubjectTest();
  }

  /** True when every rule is open — which is what decides whether the toggle
   *  offers "Expand all" or "Collapse all". An empty list counts as not open,
   *  so the button never starts out offering to collapse nothing. */
  function allSubjectRulesOpen() {
    return subjectRules.length > 0 && subjectRules.every((r) => subjectExpanded.has(r.id));
  }

  /** Opens or closes one rule. A class toggle rather than a re-render, so it
   *  costs nothing to open several and nothing on screen moves except the rule
   *  being opened. */
  function toggleSubjectRule(card, open) {
    const id = card.dataset.sid;
    const on = open === undefined ? !subjectExpanded.has(id) : open;
    if (on) subjectExpanded.add(id); else subjectExpanded.delete(id);
    card.classList.toggle('expanded', on);
    const btn = card.querySelector('.sr-toggle');
    btn.textContent = on ? '▾' : '▸';
    btn.setAttribute('aria-expanded', String(on));
    btn.title = I18n.t(on ? 'Collapse' : 'Expand');
    const all = document.getElementById('sr-expand-all');
    if (all) all.textContent = I18n.t(allSubjectRulesOpen() ? 'Collapse all' : 'Expand all');
  }

  /** The Test panel's result area, drawn on its own so a test result can be
   * repainted without re-rendering the rule cards under the cursor. */
  function renderSubjectTestOut() {
    const out = document.getElementById('sr-test-out');
    if (!out) return;
    if (subjectTest.result == null) { out.innerHTML = ''; return; }
    // data-no-i18n throughout: every string here is the user's own subject and
    // their own rule names. Without it a rule called "Delete", or a subject
    // that happens to match a catalogue entry, comes back translated — the same
    // trap the Filters tab documents on filterRow().
    const steps = subjectTest.steps.length
      ? `<div class="set-hint" data-no-i18n style="margin:6px 0 0">${subjectTest.steps.map((st) =>
          `${esc(st.name || I18n.t('Rule'))}: <s>${esc(st.before)}</s> → ${esc(st.after)}`).join('<br>')}</div>`
      : `<div class="set-hint" style="margin:6px 0 0">${I18n.t('No rule matched — the subject would be shown unchanged.')}</div>`;
    out.innerHTML = `<div class="row"><b data-no-i18n>${esc(subjectTest.result)}</b></div>${steps}`;
  }

  /** Debounced, because it runs on every keystroke in the test box. The rules
   * go WITH the request (server/index.js's /api/subject-rules/test) so what is
   * tested is what is on screen, including unsaved edits. */
  function runSubjectTest() {
    clearTimeout(subjectTest.timer);
    subjectTest.timer = setTimeout(async () => {
      const asked = subjectTest.subject;
      try {
        const r = await API.testSubjectRules(asked, subjectTest.accountId, subjectRules);
        if (asked !== subjectTest.subject) return; // typing continued — stale
        subjectTest.result = r.result;
        subjectTest.steps = r.steps || [];
      } catch {
        return; // offline / logged out; leave the last result rather than blanking it
      }
      renderSubjectTestOut();
    }, 150);
  }

  /** Reads one card back into its rule. Called on every input so the array is
   * always current — which is what lets Save, the Test panel and the dirty
   * marker all read `subjectRules` directly instead of needing a collect step. */
  function readSubjectCard(card) {
    const r = subjectRules.find((x) => x.id === card.dataset.sid);
    if (!r) return null;
    const all = card.querySelector('.sr-acct-all').checked;
    r.enabled = card.querySelector('.sr-enabled').checked;
    r.name = card.querySelector('.sr-name').value;
    r.mode = card.querySelector('.sr-mode').value;
    r.find = card.querySelector('.sr-find').value;
    r.replace = card.querySelector('.sr-replace').value;
    r.ignoreCase = card.querySelector('.sr-ci').checked;
    r.all = card.querySelector('.sr-all').checked;
    r.accountIds = all ? [] : [...card.querySelectorAll('.sr-acct')].filter((c) => c.checked).map((c) => c.value);
    return r;
  }

  function bindSubjectRows() {
    document.getElementById('sr-add')?.addEventListener('click', () => {
      const r = newSubjectRule();
      subjectRules.push(r);
      // Open, obviously — it is empty and every field still has to be filled in.
      subjectExpanded.add(r.id);
      // And visible: a filter left over from looking something up would
      // otherwise hide the rule that was just added, which reads as the button
      // being broken.
      subjectSearch = '';
      renderSubject();
      body().querySelector(`.sr-row[data-sid="${CSS.escape(r.id)}"] .sr-name`)?.focus();
    });
    document.getElementById('sr-save')?.addEventListener('click', (e) => saveSubjectRulesNow(e.currentTarget));
    body().querySelectorAll('.sr-row').forEach((card) => {
      // Typing: read the card back, keep the dirty marker and the test result
      // current, but never re-render — that would pull the field out from
      // under the cursor.
      card.querySelectorAll('input, select').forEach((el) => {
        el.addEventListener('input', () => {
          const r = readSubjectCard(card);
          markSubjectDirty();
          // The inline regex error is the one thing that has to repaint as you
          // type, so a half-written pattern doesn't sit there looking broken.
          const errBox = card.querySelector('.sr-err');
          const err = r ? subjectRuleError(r) : '';
          if (err && errBox) { errBox.textContent = err; }
          else if (err) card.querySelector('.sr-find').closest('.row').insertAdjacentHTML('afterend', `<div class="set-hint sr-err" data-no-i18n>${esc(err)}</div>`);
          else if (errBox) errBox.remove();
          // The collapsed line is what this rule will be FOUND by once it is
          // closed again, so keep it in step with the fields being typed rather
          // than letting it go stale until the next re-render.
          if (r) {
            card.querySelector('.sr-title').textContent = r.name || I18n.t('Untitled rule');
            card.querySelector('.sr-summary').textContent = subjectRuleSummary(r);
            card.querySelector('.sr-off')?.remove();
            if (r.enabled === false) {
              card.querySelector('.sr-summary').insertAdjacentHTML('afterend',
                `<span class="set-hint sr-off" style="margin:0">${I18n.t('Disabled')}</span>`);
            }
          }
          if (subjectTest.subject) runSubjectTest();
        });
      });
      // "All accounts" and the per-account boxes are mutually exclusive, and
      // switching between them enables/disables the others — a re-render is
      // right here (a checkbox has no cursor position to lose).
      card.querySelector('.sr-acct-all').addEventListener('change', (e) => {
        const r = readSubjectCard(card);
        // Turning "All accounts" OFF has to leave something selected, or the
        // rule comes back with an empty accountIds — which MEANS all accounts,
        // so the box re-checks itself and the checkbox is impossible to turn
        // off. Falling to the account you are looking at is what unchecking it
        // plainly means anyway.
        if (r && !e.target.checked && !r.accountIds.length) {
          r.accountIds = [defaultFilterAccountId()].filter(Boolean);
        }
        renderSubject();
      });
      // The whole head is the hit target, not just the ▸ — a one-line row is
      // meant to be clicked anywhere. The buttons sitting in it are the
      // exception, or Remove would open the rule on its way to deleting it.
      card.querySelector('.sr-head').addEventListener('click', (e) => {
        if (e.target.closest('button')?.classList.contains('sr-toggle') || !e.target.closest('button')) {
          toggleSubjectRule(card);
        }
      });
      card.querySelector('.sr-del').addEventListener('click', () => {
        subjectRules = subjectRules.filter((x) => x.id !== card.dataset.sid);
        renderSubject();
      });
      card.querySelector('.sr-up').addEventListener('click', () => moveSubjectRule(card.dataset.sid, -1));
      card.querySelector('.sr-down').addEventListener('click', () => moveSubjectRule(card.dataset.sid, 1));
    });
    const search = document.getElementById('sr-search');
    search?.addEventListener('input', (e) => { subjectSearch = e.target.value; applySubjectFilter(); });
    document.getElementById('sr-expand-all')?.addEventListener('click', () => {
      const open = !allSubjectRulesOpen();
      for (const card of body().querySelectorAll('.sr-row')) toggleSubjectRule(card, open);
    });
    const testInput = body().querySelector('.sr-test-input');
    testInput?.addEventListener('input', (e) => { subjectTest.subject = e.target.value; runSubjectTest(); });
    body().querySelector('.sr-test-account')?.addEventListener('change', (e) => {
      subjectTest.accountId = e.target.value;
      if (subjectTest.subject) runSubjectTest();
    });
  }

  /** Order is what the chain runs in, so this is a real edit, not a view
   * preference — it dirties the list like any other change. */
  function moveSubjectRule(id, dir) {
    const i = subjectRules.findIndex((x) => x.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= subjectRules.length) return;
    [subjectRules[i], subjectRules[j]] = [subjectRules[j], subjectRules[i]];
    renderSubject();
    // Keep the moved rule's button under the pointer, so a run of clicks walks
    // a rule up the list instead of moving whatever landed there next.
    body().querySelector(`.sr-row[data-sid="${CSS.escape(id)}"] .sr-${dir < 0 ? 'up' : 'down'}`)?.focus();
  }

  /** Saves the rules on their own, without closing the dialog — the same reason
   * the Filters tab has its own button. The server refuses the whole list if
   * any rule is bad (a chain half-saved is a different rewrite, not a smaller
   * one), and names the offending rule, so that message is worth showing
   * verbatim rather than as "could not save". */
  async function saveSubjectRulesNow(btn) {
    if (btn) btn.disabled = true;
    try {
      const saved = await API.saveSubjectRules(subjectRules);
      if (Array.isArray(saved)) subjectRules = saved;
      savedSubjectKey = subjectKey(subjectRules);
      markSubjectDirty();
      // The list is rewritten server-side, so what is on screen behind Settings
      // is now stale — repaint it rather than leaving the old subjects sitting
      // there looking current.
      loadMessages();
      toast(I18n.t('Subject rules saved'));
      return true;
    } catch (e) {
      toast(I18n.t('Could not save the subject rules') + ': ' + e.message, 5000);
      return false;
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  /* ---------- folders ---------- */
  // Independent of the sidebar's "currently open" account (state.currentAccount
  // can be 'all') — this tab has its own account picker so folders are always
  // editable no matter what's open behind Settings. Toggling "Show in sidebar"
  // here is also what the background sync (server/sync.js) and unified-view
  // fan-out treat as "include this folder" — hiding a folder here also drops
  // it from All inboxes.

  let foldersAccountId = null;
  let folderList = [];

  function foldersAccount() {
    return state.accounts.find((a) => a.id === foldersAccountId);
  }

  async function loadFoldersFor(accountId, live = false) {
    folderList = await API.folders(accountId, { live });
  }

  async function renderFolders() {
    if (!state.accounts.length) {
      body().innerHTML = `<p class="set-hint" style="grid-column:auto">No mail accounts yet.</p>`;
      return;
    }
    if (!foldersAccountId || !state.accounts.some((a) => a.id === foldersAccountId)) {
      foldersAccountId = state.currentAccount !== 'all' ? state.currentAccount : allAccounts()[0].id;
    }
    body().innerHTML = `<p class="set-hint" style="grid-column:auto">Loading…</p>`;
    await loadFoldersFor(foldersAccountId);

    // A shared account's viewer, as opposed to its owner,
    // only gets to personalize which folders show in THEIR OWN sidebar
    // (server/accountOverrides.js) — special-folder mapping, folder create/
    // rename/delete/empty all stay owner-only (they touch the real shared
    // mailbox, or its sync scope). A folder the owner already excluded from
    // sync (f.hiddenByOwner) has nothing cached to show regardless, so its
    // checkbox is locked off rather than offered as a false choice.
    const isOwner = !foldersAccount()?.shared;

    body().innerHTML = `
      <p><button class="link-btn" id="fo-back-to-accounts">← ${I18n.t('Back to accounts')}</button></p>
      <div class="card" style="margin-bottom:14px"><div class="row">
        <label style="margin-right:8px">Account</label>
        ${sel('fo-account', allAccounts().map((a) => [a.id, a.label]), foldersAccountId)}
        <span class="spacer"></span>
        <button class="icon-btn small" id="fo-reload" title="${I18n.t('Refresh')}">⟳</button>
      </div></div>
      ${isOwner ? `<div class="card" style="margin-bottom:14px">
        <div class="row" style="margin-bottom:8px"><b>${I18n.t('Special folders')}</b></div>
        <p class="set-hint" style="grid-column:auto;margin:0 0 10px">${I18n.t('Auto-detected from the server when the account was added. If sending or saving drafts fails, or the wrong folder gets used, fix the mapping here.')}</p>
        <div class="row" style="flex-wrap:wrap;gap:14px 20px">
          <label>${I18n.t('Sent folder')}&nbsp; ${sel('fo-sent', folderList.map((f) => [f.path, f.path]), foldersAccount()?.sentFolder)}</label>
          <label>${I18n.t('Drafts folder')}&nbsp; ${sel('fo-drafts', folderList.map((f) => [f.path, f.path]), foldersAccount()?.draftsFolder)}</label>
          <label>${I18n.t('Trash folder')}&nbsp; ${sel('fo-trash', folderList.map((f) => [f.path, f.path]), foldersAccount()?.trashFolder)}</label>
          <label>${I18n.t('Junk/Spam folder')}&nbsp; ${sel('fo-junk', [['', `(${I18n.t('None')})`], ...folderList.map((f) => [f.path, f.path])], foldersAccount()?.junkFolder || '')}</label>
          <label>${I18n.t('Archive folder')}&nbsp; ${sel('fo-archive', [['', `(${I18n.t('None')})`], ...folderList.map((f) => [f.path, f.path])], foldersAccount()?.archiveFolder || '')}</label>
        </div>
        <p class="set-hint" style="grid-column:auto;margin:8px 0 0">${I18n.t('These last two are what "Mark as spam" and "Move to Archive" mean for this account. Set either to (None) and that entry stops appearing in the message menus.')}</p>
        <div class="row" style="flex-wrap:wrap;gap:14px 20px;margin-top:12px">
          <label>${I18n.t('Auto-archive mail older than')}&nbsp;
            <input type="number" id="fo-autoarchive" min="0" max="3650" step="1" style="width:5em"
                   value="${escAttr(String(foldersAccount()?.autoArchiveDays || 0))}">&nbsp;${I18n.t('days')}</label>
        </div>
        <p class="set-hint" style="grid-column:auto;margin:8px 0 0">${I18n.t('0 is off. Once a day, mail older than this moves from the Inbox and its subfolders into the Archive folder above — never from Sent, Drafts, Trash, Junk or Snoozed. Each sweep is written to the Log tab.')}</p>
      </div>` : `<p class="set-hint" style="grid-column:auto">${I18n.t("This account is shared with you — pick which of its folders show in your own sidebar. The owner's settings (special folders, sync) aren't shown here.")}</p>`}
      <div class="card-list">
      ${folderList.map((f) => `<div class="card"><div class="row">
        <span>${esc(f.path)}</span>
        ${f.unseen != null ? `<span class="set-hint" style="margin:0">${f.total} msgs, ${f.unseen} unread</span>` : ''}
        ${/* A real folder on the server — which is the point, so a snoozed
              message is gone from the Inbox in Outlook and on the phone too —
              but Hmelj's, not a mailbox you keep. Named here so renaming or
              deleting it is a deliberate act: the snooze queue remembers this
              path, and messages waiting in it would have nowhere to come back
              from. The sidebar shows the 🕰️ Snoozed view instead, which also
              says when each message is due. */ ''}
        ${f.system ? `<span class="set-hint" style="margin:0" title="${escAttr(I18n.t('Snoozed messages wait here until they are due. Open the Snoozed view in the sidebar to see them.'))}">🕰️ ${I18n.t('Used by Snooze')}</span>` : ''}
        <span class="spacer"></span>
        <label class="mini-toggle" title="${f.system ? escAttr(I18n.t('Hmelj manages this folder')) : (!isOwner && f.hiddenByOwner ? escAttr(I18n.t("Hidden by this account's owner")) : '')}">
          <input type="checkbox" class="fo-show" data-path="${escAttr(f.path)}" ${f.hidden || f.system ? '' : 'checked'} ${f.system || (!isOwner && f.hiddenByOwner) ? 'disabled' : ''}> ${I18n.t('Show in sidebar')}
        </label>
        ${isOwner ? `<button class="icon-btn small fo-rename" data-path="${escAttr(f.path)}" title="${I18n.t('Rename')}">✏️</button>
        <button class="icon-btn small fo-empty" data-path="${escAttr(f.path)}" title="${I18n.t('Empty')}">🧺</button>
        <button class="icon-btn small fo-del" data-path="${escAttr(f.path)}" title="${I18n.t('Delete')}" style="color:var(--danger)">🗑</button>` : ''}
      </div></div>`).join('')}
      </div>
      ${isOwner ? `<p><button class="link-btn" id="fo-add">+ Create folder</button></p>` : ''}`;

    document.getElementById('fo-back-to-accounts').addEventListener('click', () => switchTab('accounts'));
    document.getElementById('fo-account').addEventListener('change', (e) => {
      foldersAccountId = e.target.value;
      renderFolders();
    });
    document.getElementById('fo-reload').addEventListener('click', async () => {
      try { await loadFoldersFor(foldersAccountId, true); renderFolders(); }
      catch (e) { toast('Cannot load folders: ' + e.message); }
    });
    if (isOwner) {
      // Saved on change like the pickers above, but on `change` rather than
      // `input` — a number field fires input on every keystroke, and "9" on
      // the way to "90" is a setting that would archive most of the mailbox.
      document.getElementById('fo-autoarchive')?.addEventListener('change', async (e) => {
        const days = Math.max(0, Math.min(3650, Number(e.target.value) || 0));
        e.target.value = String(days);
        const a = state.accounts.find((x) => x.id === foldersAccountId);
        if (days > 0 && !a?.archiveFolder) {
          toast(I18n.t('Pick an Archive folder first — there is nowhere to move mail to'), 6000);
          e.target.value = '0';
          return;
        }
        try {
          await API.patchAccount(foldersAccountId, { autoArchiveDays: days });
          if (a) a.autoArchiveDays = days;
          toast(days ? `${I18n.t('Auto-archiving mail older than')} ${days} ${I18n.t('days')}` : I18n.t('Auto-archive off'));
        } catch (err) { toast('Save failed: ' + err.message); }
      });

      ['sent', 'drafts', 'trash', 'junk', 'archive'].forEach((role) => {
        document.getElementById(`fo-${role}`).addEventListener('change', async (e) => {
          const key = role + 'Folder';
          try {
            await API.patchAccount(foldersAccountId, { [key]: e.target.value });
            const a = state.accounts.find((x) => x.id === foldersAccountId);
            if (a) a[key] = e.target.value;
            // hasJunk/hasArchive are what the message menus read (see
            // app.js#refileFor); they come from the accounts fetch, so without
            // this the Mark-as-spam / Move-to-Archive entries would follow a
            // change made here only after the next reload. Picking from this
            // list means the folder exists, so the value alone decides.
            if (a && (role === 'junk' || role === 'archive')) {
              a[role === 'junk' ? 'hasJunk' : 'hasArchive'] = !!e.target.value;
            }
            toast('Saved');
          } catch (err) { toast('Save failed: ' + err.message); }
        });
      });
    }

    /** Run an API call against the picked account (not necessarily the sidebar's), refresh this tab, and keep the live sidebar in sync if it happens to be the same account. */
    const withPickedAccount = async (fn) => {
      await fn(foldersAccountId);
      await renderFolders();
      if (foldersAccountId === state.currentAccount) loadFolders();
    };

    if (isOwner) {
      document.getElementById('fo-add').addEventListener('click', async () => {
        const name = await Dialog.prompt(I18n.t('Create folder'), { label: I18n.t('New folder path (use / for subfolders, e.g. Work/Invoices):') });
        if (!name) return;
        try { await withPickedAccount((acct) => API.createFolder(name, acct)); toast('Folder created'); }
        catch (e) { toast('Create failed: ' + e.message); }
      });
      body().querySelectorAll('.fo-del').forEach((b) => b.addEventListener('click', async () => {
        if (!await Dialog.confirm(I18n.t(`Delete folder "${b.dataset.path}" and all its messages?`), { title: I18n.t('Delete'), okLabel: I18n.t('Delete') })) return;
        try { await withPickedAccount((acct) => API.deleteFolder(b.dataset.path, acct)); toast('Folder deleted'); }
        catch (e) { toast('Delete failed: ' + e.message); }
      }));
      body().querySelectorAll('.fo-empty').forEach((b) => b.addEventListener('click', async () => {
        if (!await Dialog.confirm(I18n.t(`Permanently delete ALL messages in "${b.dataset.path}"?`), { title: I18n.t('Empty'), okLabel: I18n.t('Empty'), danger: true })) return;
        try { let r; await withPickedAccount(async (acct) => { r = await API.emptyFolder(b.dataset.path, acct); }); toast(`Deleted ${r.deleted} message(s)`); }
        catch (e) { toast('Empty failed: ' + e.message); }
      }));
      body().querySelectorAll('.fo-rename').forEach((b) => b.addEventListener('click', async () => {
        const np = await Dialog.prompt(I18n.t('Rename'), { label: I18n.t('New path:'), value: b.dataset.path });
        if (!np || np === b.dataset.path) return;
        try { await withPickedAccount((acct) => API.renameFolder(b.dataset.path, np, acct)); toast('Renamed'); }
        catch (e) { toast('Rename failed: ' + e.message); }
      }));
    }
    body().querySelectorAll('.fo-show').forEach((cb) => cb.addEventListener('change', async () => {
      const a = state.accounts.find((x) => x.id === foldersAccountId);
      if (!a) return;
      if (isOwner) {
        // Owner: hiddenFolders IS the real, shared list — also the sync
        // scope boundary (see sync.js), so this writes it directly.
        const hidden = new Set(a.hiddenFolders || []);
        cb.checked ? hidden.delete(cb.dataset.path) : hidden.add(cb.dataset.path);
        a.hiddenFolders = [...hidden];
        await API.patchAccount(a.id, { hiddenFolders: a.hiddenFolders });
      } else {
        // Grantee: only ever toggling their OWN additional hidden folders
        // (a.myHiddenFolders — server/accountOverrides.js) — the owner's own
        // hiddenFolders (checkbox disabled for those, see above) never
        // changes. The server unions the two back together on every read.
        const hidden = new Set(a.myHiddenFolders || []);
        cb.checked ? hidden.delete(cb.dataset.path) : hidden.add(cb.dataset.path);
        a.myHiddenFolders = [...hidden];
        await API.patchAccount(a.id, { hiddenFolders: a.myHiddenFolders });
      }
      if (foldersAccountId === state.currentAccount) loadFolders();
    }));
  }

  /* ---------- notification scheduler ----------
   * Per-account and per-folder notification schedules (server/schedule.js), plus the
   * Slovenian holiday calendar (server/holidays.js) a schedule can opt into skipping.
   * Grid polarity (confirmed with the user, not guessed): the day/time grid is when TO
   * notify — a day left unchecked, or a time outside its range, stays quiet. Schedule
   * config lives directly on the account record (notificationSchedule,
   * folderNotificationSchedules), saved immediately on every change via
   * API.patchAccount — same convention renderFolders() above already uses for
   * account-field edits, not the deferred "collect on global Save" pattern identities/
   * filters/contacts use, since this is another account field, not a separate
   * collection. */
  let schedulerAccountId = null;
  let schedulerFolderList = [];
  let schedulerHolidayYear = new Date().getFullYear();
  let schedulerHolidayList = [];

  const SCHED_DAYS = [['mon', 'Mon'], ['tue', 'Tue'], ['wed', 'Wed'], ['thu', 'Thu'], ['fri', 'Fri'], ['sat', 'Sat'], ['sun', 'Sun']];

  /** Pure HTML string for one schedule editor instance — reused inline (account-level,
   * see renderScheduler below) and inside a Dialog popup (per-folder override). Class-
   * scoped (.sched-mode/.sched-day-active/…), never id-based, since both usages can be
   * in the DOM at the same time (the settings modal stays open behind a Dialog popup) —
   * an id-based lookup would ambiguously match whichever instance happens to be first. */
  function scheduleEditorHtml(value) {
    value = value || {};
    const mode = value.mode || 'always';
    const days = value.days || {};
    return `
      <div class="sched-editor">
        <div class="row" style="margin-bottom:10px">
          <label style="margin-right:8px">${I18n.t('Notifications')}</label>
          <select class="sched-mode">
            <option value="always" ${mode === 'always' ? 'selected' : ''}>${I18n.t('Always notify')}</option>
            <option value="never" ${mode === 'never' ? 'selected' : ''}>${I18n.t('Never notify')}</option>
            <option value="scheduled" ${mode === 'scheduled' ? 'selected' : ''}>${I18n.t('Custom schedule')}</option>
          </select>
        </div>
        <div class="sched-grid-wrap" ${mode === 'scheduled' ? '' : 'hidden'}>
          <p class="set-hint" style="grid-column:auto;margin:0 0 8px">${I18n.t('The times below are when you WILL be notified — everything outside them stays quiet. Times are the server’s own local time, not necessarily yours.')}</p>
          <div class="row" style="gap:6px;margin-bottom:10px">
            <button type="button" class="link-btn sched-preset" data-preset="weekdays">${I18n.t('Weekdays')}</button>
            <button type="button" class="link-btn sched-preset" data-preset="weekend">${I18n.t('Weekend')}</button>
            <button type="button" class="link-btn sched-preset" data-preset="all">${I18n.t('All days')}</button>
            <button type="button" class="link-btn sched-preset" data-preset="none">${I18n.t('None')}</button>
          </div>
          <div class="card-list">
            ${SCHED_DAYS.map(([key, label]) => {
              const d = days[key] || {};
              return `<div class="card"><div class="row">
                <label class="mini-toggle" style="min-width:70px">
                  <input type="checkbox" class="sched-day-active" data-day="${key}" ${d.active ? 'checked' : ''}> ${I18n.t(label)}
                </label>
                <input type="time" class="sched-day-from" data-day="${key}" value="${escAttr(d.from || '08:00')}" ${d.active ? '' : 'disabled'}>
                <span>–</span>
                <input type="time" class="sched-day-to" data-day="${key}" value="${escAttr(d.to || '18:00')}" ${d.active ? '' : 'disabled'}>
              </div></div>`;
            }).join('')}
          </div>
          <label class="mini-toggle" style="margin-top:10px">
            <input type="checkbox" class="sched-skip-holidays" ${value.skipHolidays ? 'checked' : ''}> ${I18n.t('Skip Slovenian national holidays (work-free days)')}
          </label>
        </div>
      </div>`;
  }

  /** Live UI-only behavior (mode toggling the grid's visibility, preset buttons
   * batch-setting the day checkboxes) — always wired, regardless of whether the
   * instance autosaves (inline) or waits for a dialog's OK (per-folder). */
  function wireScheduleEditorUI(container) {
    const modeSel = container.querySelector('.sched-mode');
    const gridWrap = container.querySelector('.sched-grid-wrap');
    modeSel.addEventListener('change', () => { gridWrap.hidden = modeSel.value !== 'scheduled'; });
    container.querySelectorAll('.sched-day-active').forEach((cb) => cb.addEventListener('change', () => {
      const day = cb.dataset.day;
      container.querySelector(`.sched-day-from[data-day="${day}"]`).disabled = !cb.checked;
      container.querySelector(`.sched-day-to[data-day="${day}"]`).disabled = !cb.checked;
    }));
    container.querySelectorAll('.sched-preset').forEach((btn) => btn.addEventListener('click', () => {
      const preset = btn.dataset.preset; // weekdays | weekend | all | none
      const weekdays = new Set(['mon', 'tue', 'wed', 'thu', 'fri']);
      const weekend = new Set(['sat', 'sun']);
      container.querySelectorAll('.sched-day-active').forEach((cb) => {
        const day = cb.dataset.day;
        cb.checked = preset === 'all' ? true : preset === 'none' ? false : preset === 'weekdays' ? weekdays.has(day) : weekend.has(day);
        cb.dispatchEvent(new Event('change'));
      });
    }));
  }

  /** Reads a schedule editor instance's current DOM state back into the
   * {mode, days, skipHolidays} shape server/schedule.js and server/accounts.js expect. */
  function readScheduleEditorValue(container) {
    const mode = container.querySelector('.sched-mode').value;
    const days = {};
    container.querySelectorAll('.sched-day-active').forEach((cb) => {
      const day = cb.dataset.day;
      days[day] = {
        active: cb.checked,
        from: container.querySelector(`.sched-day-from[data-day="${day}"]`).value || '08:00',
        to: container.querySelector(`.sched-day-to[data-day="${day}"]`).value || '18:00',
      };
    });
    return { mode, days, skipHolidays: container.querySelector('.sched-skip-holidays').checked };
  }

  async function renderScheduler() {
    if (!state.accounts.length) {
      body().innerHTML = `<p class="set-hint" style="grid-column:auto">No mail accounts yet.</p>`;
      return;
    }
    if (!schedulerAccountId || !state.accounts.some((a) => a.id === schedulerAccountId)) {
      schedulerAccountId = state.currentAccount !== 'all' ? state.currentAccount : allAccounts()[0].id;
    }
    body().innerHTML = `<p class="set-hint" style="grid-column:auto">Loading…</p>`;
    const account = state.accounts.find((a) => a.id === schedulerAccountId);
    try { schedulerFolderList = await API.folders(schedulerAccountId); }
    catch (e) { toast('Cannot load folders: ' + e.message); schedulerFolderList = []; }
    try { schedulerHolidayList = await API.holidays(schedulerHolidayYear); }
    catch { schedulerHolidayList = []; }

    body().innerHTML = `
      <div class="card" style="margin-bottom:14px"><div class="row">
        <label style="margin-right:8px">${I18n.t('Account')}</label>
        ${sel('sch-account', allAccounts().map((a) => [a.id, a.label]), schedulerAccountId)}
      </div></div>
      <div class="card" style="margin-bottom:14px">
        <div class="row" style="margin-bottom:8px"><b>${I18n.t('Account-wide notifications')}</b></div>
        <p class="set-hint" style="grid-column:auto;margin:0 0 10px">${I18n.t('Applies to every folder in this account, unless a specific folder below has its own override.')}</p>
        <div id="sch-account-editor">${scheduleEditorHtml(account.notificationSchedule)}</div>
      </div>
      <div class="card" style="margin-bottom:14px">
        <div class="row" style="margin-bottom:8px"><b>${I18n.t('Per-folder overrides')}</b></div>
        <div class="card-list">
          ${schedulerFolderList.map((f) => {
            const override = account.folderNotificationSchedules?.[f.path];
            const effective = override || account.notificationSchedule;
            const stateLabel = !override
              ? I18n.t('Inherit')
              : (effective.mode === 'always' ? I18n.t('Always') : effective.mode === 'never' ? I18n.t('Never') : I18n.t('Scheduled'));
            // Temporary Mute (sidebar folder right-click → Mute) — shown here, and
            // liftable here, so a folder that's mysteriously quiet can be explained
            // and un-quieted from the same place its schedule lives. Set only from
            // the sidebar menu; this tab never creates one.
            const mutedUntil = ScheduleUtil.folderMutedUntil(account, f.path);
            return `<div class="card"><div class="row">
              <span>${esc(f.path)}</span>
              <span class="spacer"></span>
              ${mutedUntil ? `<span class="set-hint" style="margin:0 10px 0 0">🔕 ${I18n.t('muted until')} ${esc(fmtDate(mutedUntil))}</span>
              <button class="link-btn sch-folder-unmute" data-path="${escAttr(f.path)}">${I18n.t('Unmute')}</button>` : ''}
              <span class="set-hint" style="margin:0 10px 0 0">${stateLabel}</span>
              <button class="link-btn sch-folder-edit" data-path="${escAttr(f.path)}">${I18n.t('Edit…')}</button>
              ${override ? `<button class="link-btn sch-folder-clear" data-path="${escAttr(f.path)}">${I18n.t('Clear override')}</button>` : ''}
            </div></div>`;
          }).join('')}
        </div>
      </div>
      <div class="card">
        <div class="row" style="margin-bottom:8px"><b>${I18n.t('National holidays (Slovenia)')}</b></div>
        <p class="set-hint" style="grid-column:auto;margin:0 0 10px">${I18n.t('Generated automatically each year (Easter is calculated). Toggle whether a holiday counts as work-free — a schedule with "Skip holidays" checked stays quiet on every work-free day below. Not in Slovenia? Add your own holidays below — enter a date once and it recurs every year automatically, just like the built-in ones.')}</p>
        <div class="row" style="margin-bottom:10px">
          <label style="margin-right:8px">${I18n.t('Year')}</label>
          ${sel('sch-hol-year', [schedulerHolidayYear - 1, schedulerHolidayYear, schedulerHolidayYear + 1].map((y) => [y, y]), schedulerHolidayYear)}
        </div>
        <div class="card-list">
          ${schedulerHolidayList.map((h) => `<div class="card"><div class="row">
            <span style="min-width:90px">${esc(h.date)}</span>
            <span>${esc(h.name)}${h.custom ? ` <span class="set-hint" style="margin:0">(${I18n.t('custom')})</span>` : ''}</span>
            <span class="spacer"></span>
            <label class="mini-toggle">
              ${h.custom
                ? `<input type="checkbox" class="sch-hol-custom-workfree" data-id="${escAttr(h.id)}" ${h.workFree ? 'checked' : ''}> ${I18n.t('Work-free')}`
                : `<input type="checkbox" class="sch-hol-workfree" data-date="${escAttr(h.date)}" ${h.workFree ? 'checked' : ''}> ${I18n.t('Work-free')}`}
            </label>
            ${h.custom ? `<button class="icon-btn small sch-hol-delete" data-id="${escAttr(h.id)}" title="${I18n.t('Delete')}">🗑</button>` : ''}
          </div></div>`).join('')}
        </div>
        <div class="card" style="margin-top:10px">
          <div class="row" style="margin-bottom:8px"><b>${I18n.t('Add a custom holiday')}</b></div>
          <!-- A <br> inside each label used to do the stacking, which left the
               three controls at whatever height their own line box happened to
               be — a <select> and an <input> do not agree on that, so the month
               dropdown hung below its neighbours. Each caption and its control
               are their own flex column now; .card .row.hol-new in app.css
               gives all three controls one height. -->
          <div class="row hol-new">
            <label>${I18n.t('Month')}${sel('sch-hol-new-month', Array.from({ length: 12 }, (_, i) => [i + 1, i + 1]), 1)}</label>
            <label>${I18n.t('Day')}${num('sch-hol-new-day', 1, 1, 31)}</label>
            <label>${I18n.t('Name')}${txt('sch-hol-new-name', '', I18n.t('e.g. Independence Day'))}</label>
            <label class="mini-toggle">${chk('sch-hol-new-workfree', true)} ${I18n.t('Work-free')}</label>
            <button class="link-btn" id="sch-hol-add">+ ${I18n.t('Add')}</button>
          </div>
        </div>
      </div>`;

    document.getElementById('sch-account').addEventListener('change', (e) => { schedulerAccountId = e.target.value; renderScheduler(); });

    const acctEditorEl = document.getElementById('sch-account-editor');
    wireScheduleEditorUI(acctEditorEl);
    acctEditorEl.addEventListener('change', async () => {
      const value = readScheduleEditorValue(acctEditorEl);
      account.notificationSchedule = value;
      try { await API.patchAccount(account.id, { notificationSchedule: value }); toast('Saved'); }
      catch (e) { toast('Save failed: ' + e.message); }
    });

    document.getElementById('sch-hol-year').addEventListener('change', (e) => { schedulerHolidayYear = +e.target.value; renderScheduler(); });
    body().querySelectorAll('.sch-hol-workfree').forEach((cb) => cb.addEventListener('change', async () => {
      // Full override map from every currently-rendered row that now differs from its
      // computed default — store.js only ever needs to keep the differences, not a
      // full copy of the whole calendar.
      const overrides = {};
      body().querySelectorAll('.sch-hol-workfree').forEach((c) => {
        const h = schedulerHolidayList.find((x) => x.date === c.dataset.date);
        if (h && c.checked !== h.workFreeDefault) overrides[c.dataset.date] = c.checked;
      });
      try { await API.saveHolidayOverrides(overrides); toast('Saved'); }
      catch (e) { toast('Save failed: ' + e.message); }
    }));

    // Custom holidays: unlike the built-in Slovenian ones above, a custom entry's
    // workFree is its own field (no separate override map — see holidays.js's doc
    // comment on resolveHolidaysForYear), so this patches the entry directly.
    body().querySelectorAll('.sch-hol-custom-workfree').forEach((cb) => cb.addEventListener('change', async () => {
      try { await API.patchCustomHoliday(cb.dataset.id, { workFree: cb.checked }); toast('Saved'); }
      catch (e) { toast('Save failed: ' + e.message); cb.checked = !cb.checked; }
    }));
    body().querySelectorAll('.sch-hol-delete').forEach((btn) => btn.addEventListener('click', async () => {
      if (!await Dialog.confirm(I18n.t('Delete this custom holiday?'), { title: I18n.t('Delete'), okLabel: I18n.t('Delete') })) return;
      try { await API.deleteCustomHoliday(btn.dataset.id); toast('Deleted'); renderScheduler(); }
      catch (e) { toast('Delete failed: ' + e.message); }
    }));
    document.getElementById('sch-hol-add').addEventListener('click', async () => {
      const name = document.getElementById('sch-hol-new-name').value.trim();
      if (!name) { toast(I18n.t('Enter a name for the holiday')); return; }
      const data = {
        month: +document.getElementById('sch-hol-new-month').value,
        day: +document.getElementById('sch-hol-new-day').value,
        name,
        workFree: document.getElementById('sch-hol-new-workfree').checked,
      };
      try { await API.addCustomHoliday(data); toast('Saved'); renderScheduler(); }
      catch (e) { toast('Save failed: ' + e.message); }
    });

    body().querySelectorAll('.sch-folder-edit').forEach((btn) => btn.addEventListener('click', async () => {
      const path = btn.dataset.path;
      const current = account.folderNotificationSchedules?.[path] || account.notificationSchedule;
      // getValue: (r) => r (return the live dialog root, read the actual value out of it
      // after resolving) — same pattern the preset editor above already uses, rather than
      // computing a value inside getValue itself. Needed here specifically because this
      // editor has live cross-field behavior (mode toggling the grid, presets) that has to
      // be wired up WHILE the dialog is open, not just read once at the end — so the
      // dialog's root element has to be grabbed and wired synchronously right after
      // Dialog.form() is called (Dialog.build() has already appended it to document.body
      // by then, even though the returned Promise itself hasn't resolved) rather than only
      // after the user clicks OK.
      const formPromise = Dialog.form(I18n.t('Folder notification schedule') + ': ' + path, scheduleEditorHtml(current), {
        wide: true,
        getValue: (r) => r,
      });
      const dialogRoot = document.body.lastElementChild;
      wireScheduleEditorUI(dialogRoot.querySelector('.sched-editor'));
      const resultRoot = await formPromise;
      if (!resultRoot) return; // cancelled
      const value = readScheduleEditorValue(resultRoot.querySelector('.sched-editor'));
      const next = { ...(account.folderNotificationSchedules || {}), [path]: value };
      account.folderNotificationSchedules = next;
      try { await API.patchAccount(account.id, { folderNotificationSchedules: next }); toast('Saved'); renderScheduler(); }
      catch (e) { toast('Save failed: ' + e.message); }
    }));
    body().querySelectorAll('.sch-folder-unmute').forEach((btn) => btn.addEventListener('click', async () => {
      try {
        const r = await API.setFolderMute(account.id, btn.dataset.path, null);
        account.folderMutes = r.folderMutes || {};
        toast('Notifications back on');
        renderScheduler();
        // The sidebar's 🔕 marker and the badges behind this modal are stale the
        // moment this lands — same convention renderFolders() above uses after an
        // account-field edit.
        updateSilenceMarkers();
        if (account.id === state.currentAccount) loadFolders(); else refreshUnread();
      } catch (e) { toast('Save failed: ' + e.message); }
    }));
    body().querySelectorAll('.sch-folder-clear').forEach((btn) => btn.addEventListener('click', async () => {
      const path = btn.dataset.path;
      const next = { ...(account.folderNotificationSchedules || {}) };
      delete next[path];
      account.folderNotificationSchedules = next;
      try { await API.patchAccount(account.id, { folderNotificationSchedules: next }); toast('Saved'); renderScheduler(); }
      catch (e) { toast('Save failed: ' + e.message); }
    }));
  }

  /* ---------- login (Hmelj username/password — distinct from mail accounts) ---------- */

  /* ---------- app passwords (the CalDAV/CardDAV server) ----------
   *
   * A separate credential per device, because a DAV client stores what it is
   * given in plain form and sends it on every request. Handing a phone the
   * Hmelj account password for one calendar subscription would be handing it
   * mail, settings and every mailbox credential the account can reach.
   *
   * The secret exists in readable form exactly once — at creation. There is
   * deliberately no route that can produce it again, so this has to show it
   * there and then and say clearly that it will not come back. */
  let apList = null;

  /** What a password can be limited to — the collections this account publishes
   *  (see davPublish). Empty when nothing is shared yet, in which case the
   *  dialog does not ask. */
  let apPublications = [];

  async function loadAppPasswords() {
    try {
      const r = await API.appPasswords();
      apList = r.passwords || [];
      apPublications = r.publications || [];
    } catch { apList = []; apPublications = []; }
  }

  function renderAppPasswords() {
    const host = document.getElementById('ap-card');
    if (!host) return;
    if (apList === null) { host.innerHTML = `<div class="set-hint">${esc(I18n.t('Loading…'))}</div>`; return; }
    host.innerHTML = `
      <div class="row" style="margin-bottom:8px;align-items:baseline">
        <b>${esc(I18n.t('App passwords'))}</b>
        <span class="spacer"></span>
        <button type="button" class="link-btn" id="ap-add">+ ${esc(I18n.t('New app password'))}</button>
      </div>
      <p class="set-hint" style="grid-column:auto;margin:0 0 10px">${esc(I18n.t('For subscribing a phone or another calendar app to Hmelj over CalDAV or CardDAV. Each device gets its own, and revoking one leaves the others working. Your Hmelj password itself is never accepted there.'))}</p>
      ${!apList.length ? `<p class="set-hint" style="grid-column:auto">${esc(I18n.t('No devices set up yet.'))}</p>` : `
      <div class="card-list">${apList.map((p) => `
        <div class="card"><div class="row" style="gap:8px;align-items:baseline">
          <strong>${esc(p.label)}</strong>
          <span class="set-hint" style="margin:0">${esc((p.scopes || []).map((sc) => I18n.t(sc === 'caldav' ? 'Calendars' : 'Contacts')).join(', '))}</span>
          ${(p.pubIds || []).length ? `<span class="set-hint" style="margin:0" title="${escAttr(I18n.t('This password reaches only these shared collections.'))}">· ${
            esc(p.pubIds.map((id) => apPublications.find((x) => x.id === id)?.label || I18n.t('(removed)')).join(', '))}</span>` : ''}
          <span class="spacer"></span>
          <span class="set-hint" style="margin:0">${p.lastUsedAt
            ? `${esc(I18n.t('last used'))}: ${esc(fmtDate(p.lastUsedAt, { long: true }))}`
            : esc(I18n.t('never used'))}</span>
          <button type="button" class="link-btn danger ap-del" data-id="${escAttr(p.id)}">✕</button>
        </div></div>`).join('')}</div>`}`;

    document.getElementById('ap-add').addEventListener('click', addAppPassword);
    host.querySelectorAll('.ap-del').forEach((b) => b.addEventListener('click', () => removeAppPassword(b.dataset.id)));
  }

  async function addAppPassword() {
    const vals = await Dialog.form(I18n.t('New app password'), `
      ${field(I18n.t('What is it for?'), '<input id="ap-label" placeholder="iPhone">',
        I18n.t('A name you will recognise later, so you can revoke the right one.'))}
      <label class="mini-toggle" style="gap:6px"><input type="checkbox" id="ap-cal" checked> <span>${esc(I18n.t('Calendars'))}</span></label>
      <label class="mini-toggle" style="gap:6px"><input type="checkbox" id="ap-card" checked> <span>${esc(I18n.t('Contacts'))}</span></label>
      <p class="set-hint" style="grid-column:auto">${esc(I18n.t('Give it only what that device needs — a credential for calendars cannot read your address book.'))}</p>
      ${apPublications.length ? `
        <div class="set-section">${esc(I18n.t('Which shared collections?'))}</div>
        <label class="mini-toggle" style="gap:6px"><input type="checkbox" id="ap-all" checked> <span>${esc(I18n.t('Everything I share, including anything I share later'))}</span></label>
        <div id="ap-pubs" hidden style="margin-top:6px">
          ${apPublications.map((p) => `<label class="mini-toggle" style="gap:6px">
            <input type="checkbox" class="ap-pub" value="${escAttr(p.id)}">
            <span>${esc(p.label)}</span>
            <span class="set-hint" style="margin:0">${esc(p.kind === 'calendar' ? I18n.t('Calendar') : I18n.t('Contacts'))}</span>
          </label>`).join('')}
        </div>
        <p class="set-hint" style="grid-column:auto">${esc(I18n.t('Untick to hand this password to somebody else for particular collections only. It will not reach anything you share afterwards.'))}</p>` : ''}`,
      {
        okLabel: I18n.t('Create'),
        onOpen: (root) => {
          const all = root.querySelector('#ap-all');
          const list_ = root.querySelector('#ap-pubs');
          all?.addEventListener('change', () => { list_.hidden = all.checked; });
        },
        getValue: () => ({
          label: document.getElementById('ap-label').value.trim(),
          scopes: [
            ...(document.getElementById('ap-cal').checked ? ['caldav'] : []),
            ...(document.getElementById('ap-card').checked ? ['carddav'] : []),
          ],
          // Empty means "all of them", which is what every password meant
          // before this choice existed — see appPasswords.create.
          pubIds: document.getElementById('ap-all')?.checked === false
            ? [...document.querySelectorAll('.ap-pub')].filter((b) => b.checked).map((b) => b.value)
            : [],
        }),
      });
    if (!vals || vals === 'cancel') return;
    if (!vals.scopes.length) { toast(I18n.t('Choose at least one thing for it to reach')); return; }
    try {
      const { secret } = await API.createAppPassword(vals.label, vals.scopes, vals.pubIds);
      await loadAppPasswords();
      renderAppPasswords();
      // Shown once, and said so. The secret goes in `bodyHtml` — Dialog.alert's
      // `message` is escaped and rendered as a sentence, which is not what a
      // credential you have to copy needs.
      //
      // `readonly` rather than disabled so it can still be selected and copied
      // on every platform; run() focuses and selects the first field for us, so
      // the common case is one keystroke.
      await Dialog.alert('', {
        title: I18n.t('Your new app password'),
        bodyHtml: `
          <p class="dialog-message">${esc(I18n.t('Copy it now — it is not stored in a form that can be shown again.'))}</p>
          <input id="ap-secret" class="dialog-input" readonly value="${escAttr(secret)}"
                 style="font-family:ui-monospace,monospace;font-size:16px;text-align:center;letter-spacing:.06em">
          <p style="text-align:center;margin:10px 0 0">
            <button type="button" id="ap-copy" class="link-btn">${esc(I18n.t('Copy'))}</button>
          </p>
          <p class="set-hint">${esc(I18n.t('Use your Hmelj username with this password, and the server address shown under Settings › Calendars.'))}</p>`,
        onOpen: (root) => {
          root.querySelector('#ap-copy')?.addEventListener('click', async () => {
            const el = root.querySelector('#ap-secret');
            el.focus(); el.select();
            // execCommand is the fallback rather than the other way round:
            // navigator.clipboard is unavailable on a plain-HTTP origin, which
            // is exactly how a self-hosted Hmelj is often reached on a LAN.
            try { await navigator.clipboard.writeText(el.value); }
            catch { try { document.execCommand('copy'); } catch { /* leave it selected to copy by hand */ } }
            toast(I18n.t('Copied'), 2000);
          });
        },
      });
    } catch (e) { toast(e.message, 8000); }
  }

  async function removeAppPassword(id) {
    const p = apList.find((x) => x.id === id);
    if (!await Dialog.confirm(
      `${I18n.t('Revoke')} “${p?.label || ''}”? ${I18n.t('That device stops syncing immediately.')}`,
      { title: I18n.t('Revoke'), okLabel: I18n.t('Revoke'), danger: true })) return;
    try {
      apList = (await API.deleteAppPassword(id)).passwords || [];
      renderAppPasswords();
    } catch (e) { toast(e.message, 6000); }
  }

  /* ---------- two-factor authentication (server/totp.js) ---------- */

  let totpState = null; // null = not loaded yet

  /** The QR generator, loaded the first time a setup dialog opens and never at
   *  boot — same reasoning as the attachment viewer's vendored libraries (see
   *  public/vendor/README.md): most sessions never need it. */
  let qrLoading = null;
  function ensureQrLib() {
    if (window.qrcode) return Promise.resolve();
    if (qrLoading) return qrLoading;
    qrLoading = new Promise((resolve, reject) => {
      const el = document.createElement('script');
      el.src = '/vendor/qrcode-generator-1.4.4.min.js';
      el.addEventListener('load', () => resolve());
      el.addEventListener('error', () => { qrLoading = null; reject(new Error('Could not load the QR code generator')); });
      document.head.appendChild(el);
    });
    return qrLoading;
  }

  /** Inline SVG, not an <img>: no data: URL, no second request, and it takes
   *  the theme's own colours so the code is readable in dark mode too. */
  function qrSvg(text) {
    const qr = window.qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    return qr.createSvgTag({ cellSize: 4, margin: 4, scalable: true });
  }

  /** Shown once, and only once — the server keeps hashes, so there is no way
   *  to show them again later. Says so, rather than letting someone find out. */
  function showRecoveryCodes(codes) {
    const list = codes.map((c) => `<li>${esc(c)}</li>`).join('');
    return Dialog.alert('', {
      title: I18n.t('Recovery codes'),
      bodyHtml: `<p class="set-hint" style="margin-top:0">${esc(I18n.t('Save these somewhere safe. Each one signs you in once if you lose your authenticator — this is the only time they are shown.'))}</p>
        <ul class="totp-codes">${list}</ul>
        <p><button class="btn-sm" id="totp-copy">${esc(I18n.t('Copy'))}</button></p>`,
      onOpen: (root) => {
        root.querySelector('#totp-copy')?.addEventListener('click', () => {
          navigator.clipboard?.writeText(codes.join('\n')).then(
            () => toast(I18n.t('Copied')),
            () => toast(I18n.t('Could not copy')),
          );
        });
      },
    });
  }

  async function startTotpSetup() {
    let started;
    try {
      await ensureQrLib();
      started = await API.totpStart();
    } catch (e) { toast(e.message, 6000); return; }

    const code = await Dialog.form(
      I18n.t('Set up two-step verification'),
      `<p class="set-hint" style="margin-top:0">${esc(I18n.t('Scan this with your authenticator app, then enter the 6-digit code it shows.'))}</p>
       <div class="totp-qr" id="totp-qr"></div>
       <p class="set-hint">${esc(I18n.t('Cannot scan? Enter this key by hand:'))}<br><code class="totp-secret">${esc(started.secret)}</code></p>
       <label class="dialog-label">${esc(I18n.t('Code from the app'))}</label>
       <input class="dialog-input" id="totp-code" inputmode="numeric" autocomplete="one-time-code" maxlength="7" placeholder="000000">`,
      {
        okLabel: I18n.t('Turn on'),
        getValue: (root) => root.querySelector('#totp-code').value.trim(),
        onOpen: (root) => {
          // The URI carries the secret, so it is built by the server and only
          // ever rendered here — never logged, never put in a URL bar.
          root.querySelector('#totp-qr').innerHTML = qrSvg(started.uri);
          root.querySelector('#totp-code').focus();
        },
      },
    );
    if (!code) return; // cancelled — the pending secret is left unconfirmed and simply never used
    try {
      const r = await API.totpEnable(code);
      totpState = await API.totpStatus();
      renderTotpCard();
      await showRecoveryCodes(r.recoveryCodes || []);
    } catch (e) { toast(e.message, 6000); }
  }

  /** Both destructive-ish actions ask for the account password. See the route
   *  comments in server/index.js: a CODE would be the wrong thing to ask for,
   *  because the moment you need to turn this off is the moment you cannot
   *  produce one. */
  async function askPassword(title, okLabel) {
    return Dialog.form(
      I18n.t(title),
      `<label class="dialog-label">${esc(I18n.t('Your Hmelj password'))}</label>
       <input class="dialog-input" type="password" id="totp-pass" autocomplete="current-password">`,
      { okLabel: I18n.t(okLabel), getValue: (root) => root.querySelector('#totp-pass').value },
    );
  }

  function renderTotpCard() {
    const card = document.getElementById('totp-card');
    if (!card) return;
    if (totpState === null) { card.innerHTML = `<div class="set-hint">${esc(I18n.t('Loading…'))}</div>`; return; }
    const on = totpState.enabled;
    card.innerHTML = `
      <div class="row" style="margin-bottom:8px"><b>${esc(I18n.t('Two-step verification'))}</b></div>
      <p class="set-hint" style="grid-column:auto;margin:0 0 10px">${esc(I18n.t(on
        ? 'Signing in on the web asks for a code from your authenticator app as well as your password.'
        : 'Ask for a code from an authenticator app as well as your password when signing in on the web.'))}
        ${esc(I18n.t('App passwords are not affected — calendar and contacts clients keep working as they are.'))}</p>
      ${on
        ? `<p class="set-hint" style="margin:0 0 10px">✅ ${esc(I18n.t('On'))}${totpState.enabledAt ? ` — ${esc(fmtDate(totpState.enabledAt, { long: true }))}` : ''}
             · ${esc(I18n.t('{n} recovery codes left').replace('{n}', totpState.recoveryLeft))}</p>
           <p><button class="btn-sm" id="totp-codes">${esc(I18n.t('New recovery codes'))}</button>
              <button class="btn-sm danger" id="totp-off">${esc(I18n.t('Turn off'))}</button></p>`
        : `<p><button class="btn-sm" id="totp-on">${esc(I18n.t('Set up two-step verification'))}</button></p>`}`;

    card.querySelector('#totp-on')?.addEventListener('click', startTotpSetup);
    card.querySelector('#totp-off')?.addEventListener('click', async () => {
      const pass = await askPassword('Turn off two-step verification', 'Turn off');
      if (!pass) return;
      try {
        await API.totpDisable(pass);
        totpState = await API.totpStatus();
        renderTotpCard();
        toast(I18n.t('Two-step verification is off'));
      } catch (e) { toast(e.message, 6000); }
    });
    card.querySelector('#totp-codes')?.addEventListener('click', async () => {
      const pass = await askPassword('New recovery codes', 'Generate');
      if (!pass) return;
      try {
        const r = await API.totpRecoveryCodes(pass);
        totpState = await API.totpStatus();
        renderTotpCard();
        await showRecoveryCodes(r.recoveryCodes || []);
      } catch (e) { toast(e.message, 6000); }
    });
  }

  function renderSecurity() {
    body().innerHTML = `
      <div class="card" style="margin-bottom:14px">
        <div class="row" style="margin-bottom:8px"><b>${I18n.t('Change password')}</b></div>
        <div class="set-grid">
          ${field('Current password', '<input type="password" id="sec-curpass" autocomplete="current-password">')}
          ${field('New password', '<input type="password" id="sec-newpass" autocomplete="new-password">')}
          ${field('Confirm new password', '<input type="password" id="sec-newpass2" autocomplete="new-password">')}
        </div>
        <p><button class="btn-sm" id="sec-pass-save">${I18n.t('Change password')}</button> <span class="set-hint" id="sec-pass-status" style="margin:0"></span></p>
      </div>
      <div class="card">
        <div class="row" style="margin-bottom:8px"><b>${I18n.t('Change username')}</b></div>
        <p class="set-hint" style="grid-column:auto;margin:0 0 10px">${I18n.t("Changing your username signs you out on every device — you'll need to log back in with the new one.")}</p>
        <div class="set-grid">
          ${field('New username', `<input id="sec-newuser" autocomplete="username" value="${escAttr(state.username)}">`)}
        </div>
        <p><button class="btn-sm" id="sec-user-save">${I18n.t('Change username')}</button> <span class="set-hint" id="sec-user-status" style="margin:0"></span></p>
      </div>
      <div class="card" style="margin-top:14px" id="totp-card"></div>
      <div class="card" style="margin-top:14px" id="ap-card"></div>`;

    renderTotpCard();
    if (totpState === null) {
      API.totpStatus().then((t) => { totpState = t; renderTotpCard(); }).catch(() => {});
    }
    renderAppPasswords();
    if (apList === null) loadAppPasswords().then(renderAppPasswords);

    document.getElementById('sec-pass-save').addEventListener('click', async () => {
      const cur = document.getElementById('sec-curpass').value;
      const n1 = document.getElementById('sec-newpass').value;
      const n2 = document.getElementById('sec-newpass2').value;
      const status = document.getElementById('sec-pass-status');
      if (!cur || !n1) { status.textContent = I18n.t('Fill in all fields'); return; }
      if (n1 !== n2) { status.textContent = I18n.t('New passwords do not match'); return; }
      status.textContent = I18n.t('Saving…');
      try {
        await API.changePassword(cur, n1);
        status.textContent = I18n.t('Saved ✓');
        document.getElementById('sec-curpass').value = '';
        document.getElementById('sec-newpass').value = '';
        document.getElementById('sec-newpass2').value = '';
      } catch (e) { status.textContent = e.message; }
    });

    // Named (rather than an inline click handler) so Enter in the field runs it
    // too — this card has its own button, and Settings' big Save at the bottom
    // does NOT apply it, so a rename typed and then "saved" the usual way would
    // otherwise vanish without a word.
    async function applyUsernameChange() {
      const status = document.getElementById('sec-user-status');
      const next = document.getElementById('sec-newuser').value.trim();
      // Exact-match guard, not case-insensitive — a pure case change (e.g.
      // "andrej" -> "Andrej") is a real, allowed edit (see server/session.js's
      // displayUsername), so it must not be silently swallowed here before it
      // ever reaches the server. Both no-op cases say so rather than leaving a
      // press of the button with no visible effect at all, which is
      // indistinguishable from the change being rejected.
      if (!next) { status.textContent = I18n.t('Enter a username'); return; }
      if (next === state.username) { status.textContent = I18n.t('That is already your username'); return; }
      // Only a genuine login-name change destroys every session — a pure
      // display-case edit doesn't touch the normalized login name at all
      // (see renameUser's `unchanged` case), so it doesn't need the same
      // "you'll be signed out everywhere" warning.
      const caseOnly = next.toLowerCase() === state.username.toLowerCase();
      if (!caseOnly && !await Dialog.confirm(I18n.t("Change your username? You'll be signed out on every device and need to log back in with the new username."), { title: I18n.t('Change username'), okLabel: I18n.t('Change username') })) return;
      status.textContent = I18n.t('Saving…');
      try {
        const r = await API.changeUsername(next);
        if (r.unchanged) {
          // Same login name, new spelling — nothing signs out and nothing
          // reloads, so this is the only thing that will ever repaint the
          // sidebar, the user menu and the avatar with it.
          state.username = next;
          applyUsername();
          document.getElementById('sec-newuser').value = next;
          status.textContent = I18n.t('Saved ✓');
        } else {
          location.href = '/login.html';
        }
      } catch (e) { status.textContent = e.message; }
    }
    document.getElementById('sec-user-save').addEventListener('click', applyUsernameChange);
    document.getElementById('sec-newuser').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); applyUsernameChange(); }
    });
    // The field is only applied by its own button — say so as soon as it's
    // edited, so an edit left sitting there isn't mistaken for a saved one.
    document.getElementById('sec-newuser').addEventListener('input', (e) => {
      const status = document.getElementById('sec-user-status');
      status.textContent = e.target.value.trim() === state.username ? '' : I18n.t('Press "Change username" to apply');
    });
  }

  /* ---------- contacts ---------- */

  /** Re-reads the contact list from the server after an import and publishes it
   * to BOTH the editable draft and `state.contacts`.
   *
   * The second half is the point: `state.contacts` is what compose's recipient
   * autocomplete reads (see compose.js), and an import writes straight to the
   * server without going through Settings' Save button — so refreshing only the
   * draft left every freshly imported contact invisible in compose until the
   * next full page load. Cloned rather than shared so later edits to the draft
   * can't mutate app state behind the Save button's back. */
  async function adoptImportedContacts() {
    contacts = await API.contacts();
    state.contacts = structuredClone(contacts);
  }

  /** Suggestions from the local message cache, fetched once per Settings open
   * (the tab re-renders on every add/delete — refetching each time would be a
   * full cache scan per keystroke-ish interaction). null until first loaded. */
  let contactSuggestions = null;
  /** Fetched once per Settings open, like the contact suggestions above. null
   *  until first loaded. */
  let trustedSenders = null;

  /* Contacts tab state that has to survive a re-render (every edit, add, delete
   * and import re-renders the whole tab): the search box's text, which contacts
   * are ticked, and whether the suggestions card is expanded. Reset per Settings
   * open, not per render. */
  let ctSearch = '';
  let ctSelected = new Set();
  let ctSuggestOpen = false;
  /* Alphabetical by default. contacts.json's own order is the order things were
     added — which is no order at all once "Add people I send to" has been on for
     a year, and going through the list to prune it is exactly what that order
     makes impossible. */
  let ctSort = 'name';
  let ctFilter = '';

  const CT_SORTS = [
    ['name', 'Name A–Z'],
    ['email', 'E-mail A–Z'],
    ['added', 'As added'],
  ];
  const CT_FILTERS = [
    ['', 'All contacts'],
    ['noname', 'Without a name'],
    ['dupname', 'Same name, several addresses'],
    ['local', 'Local only'],
    ['synced', 'Synced only'],
  ];

  /** Every name held by more than one row, lowercased. The Simona case: one
   *  person's work address beside their private one, which is legitimate, next
   *  to the actual accidental duplicates — both are what you come to this
   *  filter to look at. */
  function duplicateNames() {
    const seen = new Map();
    for (const c of contacts) {
      const n = String(c.name || '').trim().toLowerCase();
      if (n) seen.set(n, (seen.get(n) || 0) + 1);
    }
    return new Set([...seen].filter(([, n]) => n > 1).map(([n]) => n));
  }

  /** Contacts matching the search box AND the filter, in the chosen order.
   * Search matches name or address, case-insensitively, on any substring — an
   * address book is searched for "@firma.si" at least as often as for a name. */
  function filteredContacts() {
    const q = ctSearch.trim().toLowerCase();
    let out = contacts;
    if (q) out = out.filter((c) => `${c.name} ${c.email}`.toLowerCase().includes(q));
    if (ctFilter === 'noname') out = out.filter((c) => !String(c.name || '').trim());
    else if (ctFilter === 'local') out = out.filter((c) => !c.synced);
    else if (ctFilter === 'synced') out = out.filter((c) => c.synced);
    else if (ctFilter === 'dupname') {
      const dups = duplicateNames();
      out = out.filter((c) => dups.has(String(c.name || '').trim().toLowerCase()));
    }
    return ctSort === 'added' ? out : sortContacts(out);
  }

  /** A copy, sorted — never the `contacts` array itself, which is the draft
   *  Save writes back and whose order is its own business.
   *
   *  Sorted by what the row actually SHOWS: a contact with no name sorts under
   *  its address rather than joining every other nameless row in a block at the
   *  top. localeCompare because č, š and ž belong after c, s and z here, not
   *  after z; `numeric` so "Sector 2" precedes "Sector 10". */
  function sortContacts(list) {
    const key = ctSort === 'email'
      ? (c) => String(c.email || '')
      : (c) => String(c.name || '').trim() || String(c.email || '');
    const lang = I18n.lang?.() || undefined;
    return [...list].sort((a, b) =>
      key(a).localeCompare(key(b), lang, { sensitivity: 'base', numeric: true }));
  }

  /* ---------- per-BROWSER list preferences ----------
   *
   * Page size and quick-delete live in localStorage, not in settings.json,
   * because they are properties of the machine you are sitting at rather than
   * of you: 500 rows a page is comfortable on the 2560px desktop and miserable
   * on the phone, and "don't ask me to confirm" is a promise you make about the
   * session you are in, not one that should follow you onto a device where the
   * ✕ is a fat-finger away from the e-mail field.
   *
   * Every read and write is guarded — a private window, or a browser set to
   * refuse site data, throws on access rather than returning null, and a
   * settings tab that cannot open because of a remembered page size would be a
   * poor trade.
   */
  const CT_VIEW_KEY = 'hmelj.contacts.view';
  // 0 is "all of them", for a small address book or a big screen.
  const CT_PAGE_SIZES = [50, 100, 200, 500, 0];
  const CT_PAGE_SIZE_DEFAULT = 200;
  let ctPageSize = CT_PAGE_SIZE_DEFAULT;
  let ctQuickDelete = false;
  let ctPage = 0;

  function loadCtView() {
    try {
      const saved = JSON.parse(localStorage.getItem(CT_VIEW_KEY) || '{}');
      if (CT_PAGE_SIZES.includes(saved.pageSize)) ctPageSize = saved.pageSize;
      ctQuickDelete = saved.quickDelete === true;
    } catch { /* unreadable or absent — the defaults above are the answer */ }
  }
  function saveCtView() {
    try {
      localStorage.setItem(CT_VIEW_KEY, JSON.stringify({ pageSize: ctPageSize, quickDelete: ctQuickDelete }));
    } catch { /* nothing to do: the preference just won't outlive the tab */ }
  }
  loadCtView();

  /** ‹ › and "showing 201–400 of 843", drawn above AND below the list — with a
   *  full page of rows on screen, a pager only at the top is a scroll back up
   *  for every single page. */
  function ctPagerHtml(total, from, to, pages) {
    if (pages < 2) return '';
    return `<div class="row ct-pager">
      <button type="button" class="btn-sm ct-prev"${ctPage === 0 ? ' disabled' : ''}>‹ ${I18n.t('Previous')}</button>
      <span class="set-hint" style="margin:0">${from}–${to} ${I18n.t('of')} ${total}</span>
      <button type="button" class="btn-sm ct-next"${ctPage >= pages - 1 ? ' disabled' : ''}>${I18n.t('Next')} ›</button>
      <span class="set-hint" style="margin:0">${I18n.t('Page')} ${ctPage + 1} / ${pages}</span>
    </div>`;
  }

  /* ---------- contact groups (server/contactGroups.js) ----------
   *
   * A group is a NAME and a set of addresses. It lives on this tab rather than
   * in a tab of its own because it is made out of what is on this tab, and the
   * two are edited in one sitting: tick four contacts, add them to a group.
   *
   * Members are stored as addresses, not as contact ids — a synced contact's id
   * is derived from its card and changes when the card is re-synced
   * (server/contactSources.js#allRowsFor), so a group keyed on ids would
   * quietly lose people. It also means a group can hold an address that is not
   * in the address book at all, which is what a hand-typed one is.
   *
   * Drafted like the contact list itself: edits ride along on the tab's Save,
   * and the server's normalised answer is adopted afterwards (it disambiguates
   * duplicate names, which the `👥 Name` token depends on being unique).
   */
  const GROUP_MARK = '👥';

  /** "3 people" / "1 person", translated. Built as one whole string rather
   *  than a number glued to a translated word, because Slovenian does not
   *  inflect the noun the way English does — see the `^(\d+) people$` regex in
   *  the language files. */
  function peopleLabel(n) {
    return I18n.t(n === 1 ? '1 person' : `${n} people`);
  }

  /** How a member address is shown: with the contact's name when we know one,
   *  bare otherwise. Resolved at RENDER time rather than stored, so a contact
   *  renamed on this same tab is renamed in every group they are in. */
  function memberLabel(email) {
    const c = contacts.find((x) => String(x.email || '').toLowerCase() === email);
    return c && c.name ? `${c.name} <${email}>` : email;
  }

  /** Reads the group name inputs back out of the DOM. Same deferred-pane
   *  contract as the contact rows: typed edits are collected on Save, and any
   *  action that RE-RENDERS the card has to collect first or lose them. */
  function collectGroups() {
    for (const row of body().querySelectorAll('#ct-groups [data-group]')) {
      const g = contactGroups.find((x) => x.id === row.dataset.group);
      if (g) g.name = row.querySelector('.cg-name').value;
    }
  }

  function renderGroupsCard() {
    const host = document.getElementById('ct-groups');
    if (!host) return;
    host.innerHTML = `
      <div class="row" style="gap:8px">
        <strong>${esc(I18n.t('Groups'))}</strong>
        <span class="spacer"></span>
        <button type="button" class="link-btn" id="cg-add">+ ${esc(I18n.t('New group'))}</button>
      </div>
      <div class="set-hint">${esc(I18n.t('A group is a name for several addresses. Type its name in To, Cc or Bcc and pick it — Hmelj puts the people in when the message is sent.'))}</div>
      ${contactGroups.length ? `<div class="card-list" style="margin-top:8px">${contactGroups.map((g) => `
        <div class="card" data-group="${escAttr(g.id)}"><div class="row">
          <span class="f-icon">${GROUP_MARK}</span>
          <input class="cg-name grow" value="${escAttr(g.name)}" placeholder="${escAttr(I18n.t('Group name'))}">
          <button type="button" class="link-btn cg-members">${esc(peopleLabel(g.members.length))}</button>
          <button type="button" class="link-btn cg-write" title="${escAttr(I18n.t('New message'))}">✉</button>
          <button type="button" class="link-btn cg-del">✕</button>
        </div></div>`).join('')}</div>`
        : `<p class="set-hint" style="margin-top:8px">${esc(I18n.t('No groups yet.'))}</p>`}`;

    const groupOf = (el) => contactGroups.find((x) => x.id === el.closest('[data-group]').dataset.group);

    document.getElementById('cg-add').addEventListener('click', () => {
      collectGroups();
      contactGroups.push({ id: uid(), name: '', members: [] });
      renderGroupsCard();
      const input = host.querySelector('[data-group]:last-child .cg-name');
      input?.scrollIntoView({ block: 'nearest' });
      input?.focus();
    });
    host.querySelectorAll('.cg-members').forEach((b) => b.addEventListener('click', async () => {
      collectGroups();
      await editGroupMembers(groupOf(b));
      renderGroupsCard();
    }));
    host.querySelectorAll('.cg-write').forEach((b) => {
      const g = groupOf(b);
      b.addEventListener('click', () => {
        collectGroups();
        const name = String(g.name || '').trim();
        if (!name) { toast(I18n.t('Give the group a name first')); return; }
        // What goes into To is the TOKEN, not the addresses — the server is
        // what expands it, at send (see server/contactGroups.js). Which is
        // exactly why an unsaved group cannot be written to yet: the server has
        // never heard of that name, so the send would be refused. Say so rather
        // than closing Settings over the top of the edit that caused it.
        if (!(state.contactGroups || []).some((x) => x.name === name)) {
          toast(I18n.t('Save this group first — Hmelj fills the people in when the message is sent.'), 5000);
          return;
        }
        close();
        Compose.open({ to: `${GROUP_MARK} ${name}` });
      });
    });
    host.querySelectorAll('.cg-del').forEach((b) => b.addEventListener('click', async () => {
      const g = groupOf(b);
      if (!await Dialog.confirm(
        `${I18n.t('Remove this group?')} "${g.name || I18n.t('Group')}"`,
        { title: I18n.t('Remove'), okLabel: I18n.t('Remove'), danger: true })) return;
      collectGroups();
      contactGroups = contactGroups.filter((x) => x.id !== g.id);
      renderGroupsCard();
    }));
  }

  /**
   * Who is in one group. A dialog rather than an inline expansion: a group of
   * thirty would push the whole contact list off the screen, and this is a
   * "sort this list out" job rather than something glanced at.
   *
   * Members are added from the address book by searching it, or typed in by
   * hand — a group may legitimately contain somebody who is not a contact.
   */
  async function editGroupMembers(g) {
    let members = [...g.members];
    const rowsHtml = () => (members.length
      ? members.map((m) => `<div class="row" data-member="${escAttr(m)}" style="gap:8px">
          <span class="grow">${esc(memberLabel(m))}</span>
          <button type="button" class="link-btn cg-drop">✕</button>
        </div>`).join('')
      : `<p class="set-hint">${esc(I18n.t('Nobody in this group yet.'))}</p>`);
    // Contacts not already in, matched the same way the tab's own search box
    // matches (name or address, any substring).
    const matchesFor = (q) => {
      const inGroup = new Set(members);
      const needle = q.trim().toLowerCase();
      if (!needle) return [];
      return contacts
        .filter((c) => c.email && !inGroup.has(String(c.email).toLowerCase())
          && `${c.name} ${c.email}`.toLowerCase().includes(needle))
        .slice(0, 20);
    };

    const result = await Dialog.form(
      `${GROUP_MARK} ${g.name || I18n.t('Group')}`,
      `<div class="cg-editor">
        <div id="cg-members" class="card-list" style="margin-bottom:10px">${rowsHtml()}</div>
        <input id="cg-search" class="dialog-input" type="search" autocomplete="off"
          placeholder="${escAttr(I18n.t('Search contacts, or type an address'))}">
        <div id="cg-matches" class="card-list" style="margin-top:8px"></div>
      </div>`,
      {
        okLabel: I18n.t('Done'),
        getValue: () => members,
        onOpen: (root) => {
          const list = root.querySelector('#cg-members');
          const matchBox = root.querySelector('#cg-matches');
          const search = root.querySelector('#cg-search');
          const paintMembers = () => {
            list.innerHTML = rowsHtml();
            list.querySelectorAll('.cg-drop').forEach((b) => b.addEventListener('click', () => {
              members = members.filter((m) => m !== b.closest('[data-member]').dataset.member);
              paintMembers();
              paintMatches();
            }));
          };
          const add = (email) => {
            const addr = String(email || '').trim().toLowerCase();
            if (!addr.includes('@') || members.includes(addr)) return;
            members.push(addr);
            search.value = '';
            paintMembers();
            paintMatches();
            search.focus();
          };
          function paintMatches() {
            const typed = search.value;
            const found = matchesFor(typed);
            // A typed address that matches nobody is still addable — that is
            // how somebody who is not in the address book gets into a group.
            const raw = typed.trim().toLowerCase();
            const offerRaw = raw.includes('@') && !members.includes(raw)
              && !found.some((c) => String(c.email).toLowerCase() === raw);
            matchBox.innerHTML = [
              ...(offerRaw ? [`<button type="button" class="link-btn cg-pick" data-email="${escAttr(raw)}">+ ${esc(raw)}</button>`] : []),
              ...found.map((c) => `<button type="button" class="link-btn cg-pick" data-email="${escAttr(c.email)}">+ ${esc(c.name ? `${c.name} <${c.email}>` : c.email)}</button>`),
            ].join('');
            matchBox.querySelectorAll('.cg-pick').forEach((b) =>
              b.addEventListener('click', () => add(b.dataset.email)));
          }
          search.addEventListener('input', paintMatches);
          // Enter inside the search box adds the top match instead of closing
          // the dialog — which is what the dialog's own Enter handler would
          // otherwise do, mid-edit, on the first person added.
          search.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter') return;
            const first = matchBox.querySelector('.cg-pick');
            if (!first) return;
            e.preventDefault();
            e.stopPropagation();
            add(first.dataset.email);
          });
          paintMembers();
          paintMatches();
        },
      },
    );
    if (result) g.members = result;
  }

  /** "Add to group" for the ticked contacts — the reason the Groups card sits
   *  on this tab at all. Offers the existing groups plus a new one. */
  async function addSelectedToGroup() {
    collectContacts();
    collectGroups();
    const picked = contacts.filter((c) => ctSelected.has(c.id) && c.email);
    if (!picked.length) return;
    const choice = await Dialog.choose(
      I18n.t(`Add ${picked.length} contact(s) to which group?`),
      {
        title: I18n.t('Add to group'),
        buttons: [
          ...contactGroups.filter((g) => String(g.name || '').trim())
            .map((g) => ({ label: `${GROUP_MARK} ${g.name}`, value: g.id })),
          { label: `+ ${I18n.t('New group')}`, value: '__new__', primary: true },
        ],
      },
    );
    if (!choice) return;
    let group;
    if (choice === '__new__') {
      const name = await Dialog.prompt(I18n.t('Name for this group'));
      if (!name) return;
      group = { id: uid(), name: name.trim(), members: [] };
      contactGroups.push(group);
    } else {
      group = contactGroups.find((g) => g.id === choice);
      if (!group) return;
    }
    const before = group.members.length;
    for (const c of picked) {
      const addr = String(c.email).trim().toLowerCase();
      if (!group.members.includes(addr)) group.members.push(addr);
    }
    toast(I18n.t(`Added ${group.members.length - before} to "${group.name}"`));
    ctSelected.clear();
    renderContacts();
  }

  /* ---------- live contact sync (server/contactsSync/*) ----------
   *
   * A "source" is one server's worth of address books: a CardDAV URL with its
   * own password, or a mail account whose OAuth sign-in is borrowed. Each source
   * exposes one or more BOOKS, and the user ticks the ones they want.
   *
   * Kept in its own state, refetched rather than drafted: unlike the settings on
   * this tab, saving a source has side effects on somebody else's server, so it
   * happens immediately on its own dialog's Save rather than riding along on the
   * tab's Save button. */
  let ctSources = null;      // null until first fetched
  let ctSourceKinds = {};
  let ctSyncing = new Set(); // source ids with a sync in flight

  async function loadContactSources() {
    try {
      const r = await API.contactSources();
      ctSources = r.sources || [];
      ctSourceKinds = r.kinds || {};
    } catch { ctSources = []; }
  }

  /** Mail accounts whose sign-in a source of this kind could borrow. */
  function ctAccountsFor(kind) {
    if (kind === 'graph') return allAccounts().filter((a) => a.type === 'graph' && !a.disabled);
    if (kind === 'ews') return allAccounts().filter((a) => a.type === 'ews' && !a.disabled);
    if (kind === 'google') {
      // A Gmail account signed in with OAuth — a Gmail account on an app
      // password has no token to borrow, and offering it would produce a source
      // that can never authenticate.
      return allAccounts().filter((a) => !a.disabled && a.oauth?.provider === 'google');
    }
    return [];
  }

  function ctSourceStatus(src) {
    const books = (src.books || []).filter((b) => b.enabled);
    const err = src.lastError || books.map((b) => b.lastError).find(Boolean);
    if (err) return `<span class="set-hint" style="margin:0;color:var(--danger)">${esc(err)}</span>`;
    if (!books.length) return `<span class="set-hint" style="margin:0">${esc(I18n.t('No address book selected yet'))}</span>`;
    const total = books.reduce((n, b) => n + (b.count || 0), 0);
    const when = src.lastSyncAt ? fmtDate(src.lastSyncAt, { long: true }) : I18n.t('never');
    return `<span class="set-hint" style="margin:0">${total} ${esc(I18n.t('contacts'))} · ${esc(I18n.t('last synced'))}: ${esc(when)}</span>`;
  }

  function renderContactSources() {
    const host = document.getElementById('ct-sources');
    if (!host) return;
    if (ctSources === null) {
      host.innerHTML = `<div class="set-hint">${esc(I18n.t('Loading…'))}</div>`;
      return;
    }
    // Only offer the source types this instance could actually use — a Google
    // source needs a Gmail account signed in with OAuth, and offering one where
    // there is none produces a source that can never authenticate.
    const addable = Object.entries(ctSourceKinds)
      .filter(([kind, meta]) => meta.credentials === 'own' || ctAccountsFor(kind).length);

    host.innerHTML = `
      <div class="row" style="align-items:baseline;gap:8px;margin-bottom:8px">
        <strong>${esc(I18n.t('Synced address books'))}</strong>
        <span class="spacer"></span>
        ${addable.map(([kind, meta]) =>
          `<button type="button" class="link-btn ct-src-add" data-kind="${escAttr(kind)}">+ ${esc(meta.label)}</button>`).join('')}
      </div>
      <div class="set-hint" style="margin-top:0">${esc(I18n.t('Contacts from these servers stay up to date on their own. They are kept separately from the contacts you type here, so removing a source never touches your own address book.'))}</div>
      ${!ctSources.length ? '' : `<div class="card-list" style="margin-top:10px">${ctSources.map((src) => `
        <div class="card" data-src="${escAttr(src.id)}">
          <div class="row" style="gap:8px;align-items:baseline">
            <strong>${esc(src.label)}</strong>
            <span class="set-hint" style="margin:0">${esc(ctSourceKinds[src.kind]?.label || src.kind)}</span>
            ${src.direction === 'two-way' ? `<span class="set-hint" style="margin:0">↔ ${esc(I18n.t('two-way'))}</span>` : ''}
            <span class="spacer"></span>
            <button type="button" class="link-btn ct-src-sync" data-src="${escAttr(src.id)}" ${ctSyncing.has(src.id) ? 'disabled' : ''}>${esc(ctSyncing.has(src.id) ? I18n.t('Syncing…') : I18n.t('Sync now'))}</button>
            <button type="button" class="link-btn ct-src-edit" data-src="${escAttr(src.id)}">${esc(I18n.t('Edit'))}</button>
            <button type="button" class="link-btn danger ct-src-del" data-src="${escAttr(src.id)}">✕</button>
          </div>
          <div class="row" style="margin-top:4px">${ctSourceStatus(src)}</div>
          ${(src.books || []).length ? `<div style="margin-top:6px">${src.books.map((b) => `
            <label class="mini-toggle" style="gap:6px">
              <input type="checkbox" class="ct-book" data-src="${escAttr(src.id)}" data-book="${escAttr(b.id)}" ${b.enabled ? 'checked' : ''}>
              <span>${esc(b.displayName)}</span>
              ${b.readOnly ? `<span class="set-hint" style="margin:0">${esc(I18n.t('read-only'))}</span>` : ''}
              ${b.count ? `<span class="set-hint" style="margin:0">${b.count}</span>` : ''}
            </label>`).join('')}</div>` : ''}
        </div>`).join('')}</div>`}`;

    host.querySelectorAll('.ct-src-add').forEach((b) => b.addEventListener('click', () => editContactSource(null, b.dataset.kind)));
    host.querySelectorAll('.ct-src-edit').forEach((b) => b.addEventListener('click', () => {
      editContactSource(ctSources.find((x) => x.id === b.dataset.src));
    }));
    host.querySelectorAll('.ct-src-del').forEach((b) => b.addEventListener('click', () => removeContactSource(b.dataset.src)));
    host.querySelectorAll('.ct-src-sync').forEach((b) => b.addEventListener('click', () => syncContactSourceNow(b.dataset.src)));
    host.querySelectorAll('.ct-book').forEach((b) => b.addEventListener('change', () => toggleContactBook(b.dataset.src, b.dataset.book, b.checked)));
  }

  /** Add or edit one source. Discovery runs from inside the dialog, so a
   *  mistyped password is corrected there instead of leaving a broken source
   *  saved behind — which is what happens with a save-then-discover flow, and
   *  it is the common case when adding one. */
  async function editContactSource(existing, kind = null) {
    const k = existing?.kind || kind || 'carddav';
    const meta = ctSourceKinds[k] || {};
    const accounts = ctAccountsFor(k);
    if (meta.credentials === 'account' && !accounts.length) {
      toast(I18n.t('No mail account of that type to sign in with'), 5000);
      return;
    }
    const body = `
      ${field(I18n.t('Name'), `<input id="cs-label" value="${escAttr(existing?.label || meta.label || '')}">`)}
      ${k === 'carddav' ? `
        ${field(I18n.t('Server address'), `<input id="cs-url" placeholder="https://cloud.example.com" value="${escAttr(existing?.url || '')}">`,
          I18n.t('The server, or the address book itself if you already have its URL. Hmelj works the rest out.'))}
        ${field(I18n.t('Username'), `<input id="cs-user" autocomplete="off" value="${escAttr(existing?.username || '')}">`)}
        ${field(I18n.t('Password'), `<input id="cs-pass" type="password" autocomplete="new-password" placeholder="${escAttr(existing?.passwordSet ? I18n.t('unchanged') : '')}">`,
          I18n.t('If your provider uses two-factor authentication, this has to be an app-specific password generated in their own settings — the account password will always be refused.'))}
      ` : field(I18n.t('Sign in with'), sel('cs-account', accounts.map((a) => [a.id, a.label]), existing?.accountId || accounts[0]?.id))}
      ${field(I18n.t('Direction'), sel('cs-direction', [
        ['pull', I18n.t('Read only — never change anything on the server')],
        ['two-way', I18n.t('Two-way — edits here are written back')],
      ], existing?.direction || 'pull'))}`;

    const vals = await Dialog.form(existing ? I18n.t('Edit address book source') : I18n.t('Add address book source'), body, {
      okLabel: I18n.t('Continue'),
      getValue: () => ({
        label: document.getElementById('cs-label').value.trim(),
        url: document.getElementById('cs-url')?.value.trim() || '',
        username: document.getElementById('cs-user')?.value.trim() || '',
        password: document.getElementById('cs-pass')?.value || '',
        accountId: document.getElementById('cs-account')?.value || '',
        direction: document.getElementById('cs-direction').value,
      }),
    });
    if (!vals || vals === 'cancel') return;

    const draft = { ...vals, kind: k, id: existing?.id };

    // Before discovery, not after: without the contacts permission the probe
    // comes back 401 with nothing useful to say, and the user is left believing
    // the account itself is broken.
    if (meta.credentials === 'account') {
      const account = accounts.find((a) => a.id === draft.accountId);
      if (!await ensureOAuthFeature(account, 'contacts')) return;
    }

    let found;
    try {
      toast(I18n.t('Looking for address books…'), 2500);
      found = await API.discoverContactSource(draft);
    } catch (e) {
      toast(I18n.t('Could not reach that server: ') + e.message, 8000);
      return;
    }
    if (!found.collections?.length) {
      toast(I18n.t('That server answered, but has no address books this account can see.'), 8000);
      return;
    }

    // Which books to sync, chosen against what the server actually reported —
    // never guessed, and never all of them by default: a work server routinely
    // shares a company-wide book of several thousand people.
    const previous = new Map((existing?.books || []).map((b) => [b.href, b]));
    const pick = await Dialog.form(I18n.t('Address books'),
      `<div class="pick-list">${found.collections.map((c, i) => `<label class="pick-row">
        <input type="checkbox" class="cs-book" data-i="${i}" ${previous.get(c.href)?.enabled || (!existing && found.collections.length === 1) ? 'checked' : ''}>
        <span class="pick-name">${esc(c.displayName)}</span>
        ${c.readOnly ? `<span class="pick-tag">${esc(I18n.t('read-only'))}</span>` : ''}
      </label>`).join('')}</div>`,
      { okLabel: I18n.t('Save'), getValue: () => [...document.querySelectorAll('.cs-book')].map((b) => b.checked) });
    if (!pick || pick === 'cancel') return;

    try {
      await API.saveContactSource({
        ...draft,
        principalUrl: found.principalUrl, homeUrl: found.homeUrl,
        books: found.collections.map((c, i) => ({ ...previous.get(c.href), ...c, enabled: !!pick[i] })),
      }, existing?.id);
      await loadContactSources();
      renderContactSources();
      if (existing?.id || ctSources.length) await syncContactSourceNow(existing?.id || ctSources.at(-1).id);
    } catch (e) {
      toast(I18n.t('Could not save that source: ') + e.message, 8000);
    }
  }

  async function removeContactSource(id) {
    const src = ctSources.find((x) => x.id === id);
    if (!await Dialog.confirm(
      `${I18n.t('Stop syncing')} ${src?.label || ''}? ${I18n.t('Its contacts are removed from Hmelj. Nothing is deleted on the server, and your own contacts are untouched.')}`,
      { title: I18n.t('Stop syncing'), okLabel: I18n.t('Stop syncing'), danger: true })) return;
    try {
      await API.deleteContactSource(id);
      await loadContactSources();
      await adoptImportedContacts();
      renderContacts();
    } catch (e) { toast(e.message, 6000); }
  }

  async function toggleContactBook(sourceId, bookId, enabled) {
    const src = ctSources.find((x) => x.id === sourceId);
    if (!src) return;
    try {
      await API.saveContactSource({
        ...src,
        books: (src.books || []).map((b) => (b.id === bookId ? { ...b, enabled } : b)),
      }, sourceId);
      await loadContactSources();
      if (enabled) await syncContactSourceNow(sourceId);
      else { await adoptImportedContacts(); renderContacts(); }
    } catch (e) { toast(e.message, 6000); }
  }

  async function syncContactSourceNow(id) {
    if (!id || ctSyncing.has(id)) return;
    ctSyncing.add(id);
    renderContactSources();
    try {
      const r = await API.syncContactSource(id);
      const totals = (r.books || []).reduce((a, b) => ({
        added: a.added + (b.added || 0), updated: a.updated + (b.updated || 0), removed: a.removed + (b.removed || 0),
      }), { added: 0, updated: 0, removed: 0 });
      const failed = (r.books || []).find((b) => b.error);
      if (failed) toast(`${I18n.t('Sync failed')}: ${failed.error}`, 8000);
      else if (totals.added || totals.updated || totals.removed) {
        toast(`${I18n.t('Synced')}: +${totals.added} ~${totals.updated} -${totals.removed}`);
      } else toast(I18n.t('Already up to date'));
      ctSources = r.sources || ctSources;
      await adoptImportedContacts();
    } catch (e) {
      toast(`${I18n.t('Sync failed')}: ${e.message}`, 8000);
    } finally {
      ctSyncing.delete(id);
      renderContacts();
    }
  }

  /** One contact row. A synced row is deliberately NOT the same control as a
   *  local one: it has no tick box (bulk delete works by filtering the local
   *  array, which for a synced contact would change nothing on the server), and
   *  its fields commit to their own server as they are edited rather than
   *  waiting for this tab's Save button. */
  function contactRowHtml(c) {
    if (!c.synced) {
      return `<div class="card" data-id="${escAttr(c.id)}"><div class="row">
        <input type="checkbox" class="ct-pick" data-id="${escAttr(c.id)}" ${ctSelected.has(c.id) ? 'checked' : ''}>
        <input class="ct-name grow" value="${escAttr(c.name)}" placeholder="Name">
        <input class="ct-email grow" value="${escAttr(c.email)}" placeholder="email@example.com">
        <button class="link-btn ct-del" data-id="${escAttr(c.id)}" title="${escAttr(ctQuickDelete ? I18n.t('Delete (no confirmation)') : I18n.t('Delete this contact?'))}">✕</button>
      </div></div>`;
    }
    const ro = c.readOnly ? 'disabled' : '';
    return `<div class="card" data-id="${escAttr(c.id)}" data-synced="1"><div class="row">
      <span class="ct-sync-mark" title="${escAttr(`${c.sourceLabel} · ${c.bookName}`)}">☁</span>
      <input class="ct-name grow" value="${escAttr(c.name)}" placeholder="Name" ${ro}>
      <input class="ct-email grow" value="${escAttr(c.email)}" placeholder="email@example.com" ${ro}>
      ${c.readOnly ? '' : `<button class="link-btn ct-del-synced" data-id="${escAttr(c.id)}">✕</button>`}
    </div></div>`;
  }

  /** Writes one synced row back to the server it came from. Fired on `change`
   *  (i.e. on blur, not per keystroke), because each one is a network write to
   *  somebody else's server. */
  async function commitSyncedRow(card) {
    const id = card.dataset.id;
    const row = contacts.find((c) => c.id === id);
    if (!row) return;
    const name = card.querySelector('.ct-name').value.trim();
    const email = card.querySelector('.ct-email').value.trim();
    if (name === row.name && email === row.email) return;
    if (!email.includes('@')) { toast(I18n.t('A contact needs an e-mail address')); return; }
    try {
      const r = await API.updateSyncedContact(id, { name, email });
      contacts = r.contacts;
      state.contacts = structuredClone(contacts);
      renderContacts();
    } catch (e) {
      // A 412 means somebody changed the contact on the other side while this
      // was open. Saying so and re-reading is the only honest answer — retrying
      // without the condition would silently destroy their edit.
      toast(e.message, 8000);
      await adoptImportedContacts();
      renderContacts();
    }
  }

  /* ---------- CSV import, with the columns named by hand ----------
   *
   * "Export the company address book and import it here" used to work only if
   * the export happened to be shaped like Google's, because the server picked
   * its columns by pattern (see the /api/contacts/import route) and said
   * nothing when it found none — an import that reported success and added
   * zero contacts. Real exports have "Priimek" where Google has "Last Name",
   * arrive semicolon-separated out of a European Excel, and keep the name in
   * two columns that have to be joined.
   *
   * So the file is read here (public/js/csv.js), the columns are guessed, and
   * the guess is shown as three dropdowns over a live preview of the first few
   * contacts as they would be saved. Wrong guess, one dropdown, done — and
   * nothing is sent until the preview says the right thing.
   */

  // Anchored, so "E-mail Address" cannot be mistaken for a name column.
  const CT_COL_FIRST = /^(first[\s_-]*names?|given[\s_-]*names?|fore[\s_-]*names?|name|full[\s_-]*name|display[\s_-]*name|ime|polno[\s_-]*ime|naziv)$/i;
  const CT_COL_LAST = /^(last[\s_-]*names?|surnames?|family[\s_-]*names?|priimek)$/i;
  const CT_COL_MAIL = /(e-?mail|e-?po[sš]ta|elektronsk)/i;

  /** The e-mail column, by header and then by what is actually IN the column.
   *
   * The data test is not a fallback for exotic files, it is the main event for
   * Google's own: its header has "E-mail 1 - Type" sitting in front of
   * "E-mail 1 - Value", and both match any pattern loose enough to match
   * either. The one with addresses in it is the one that wins. It also rescues
   * a file whose headers are in a language nobody thought of, and one with no
   * header at all. */
  function guessEmailColumn(header, dataRows) {
    const width = Math.max(header.length, ...dataRows.map((r) => r.length), 0);
    const hasAddresses = (i) => dataRows.some((r) => String(r[i] || '').includes('@'));
    const named = [];
    for (let i = 0; i < width; i++) if (CT_COL_MAIL.test(header[i] || '')) named.push(i);
    return named.find(hasAddresses)
      ?? named[0]
      ?? [...Array(width).keys()].find(hasAddresses)
      ?? -1;
  }

  function guessColumn(header, re) {
    const i = header.findIndex((h) => re.test(h || ''));
    return i === -1 ? -1 : i;
  }

  /** When neither name pattern matched anything — a file with no header at all,
   *  or one whose columns are called things like "Sodelavec" — the first column
   *  that holds text and is not the address is very nearly always the name.
   *  Guessing it beats leaving the dialog with the name field empty, and the
   *  preview underneath is where a wrong guess shows up immediately. */
  function guessNameColumn(dataRows, emailColumn, width) {
    for (let i = 0; i < width; i++) {
      if (i === emailColumn) continue;
      if (dataRows.some((r) => { const v = String(r[i] || '').trim(); return v && !v.includes('@'); })) return i;
    }
    return -1;
  }

  /** One column's label in the dropdowns: what it is called, and what is in it
   *  — a header alone is not enough to choose by when two of them are called
   *  "Name 1" and "Name 2". */
  function columnLabel(i, header, dataRows, hasHeader) {
    const name = hasHeader && header[i] ? header[i] : `${I18n.t('Column')} ${i + 1}`;
    const sample = dataRows.map((r) => String(r[i] || '').trim()).find(Boolean) || '';
    return sample ? `${name} — ${sample.slice(0, 28)}` : name;
  }

  /** The rows this mapping would save. Also what the preview draws, so what is
   *  on screen and what is sent cannot disagree. */
  function mappedRows(dataRows, map) {
    const at = (r, i) => (i >= 0 ? String(r[i] || '').trim() : '');
    const out = [];
    for (const r of dataRows) {
      const email = at(r, map.email);
      if (!email.includes('@')) continue;      // a header repeated mid-file, a total row, a blank
      const name = [at(r, map.first), at(r, map.last)].filter(Boolean).join(' ');
      out.push({ name, email });
    }
    return out;
  }

  async function importCsvWithMapping(text, filename) {
    const { delimiter, rows } = Csv.parse(text);
    if (!rows.length) { toast(I18n.t('That file has no rows in it')); return; }

    const delimiterName = { ',': ',', ';': ';', '\t': I18n.t('tab') }[delimiter] || delimiter;
    const width = Math.max(...rows.map((r) => r.length));
    let hasHeader = Csv.looksLikeHeader(rows[0]);

    const bodyHtml = `
      <p class="dialog-label">${esc(filename || 'CSV')} — <span id="cm-count"></span></p>
      <label class="mini-toggle" style="gap:6px;margin-bottom:10px">
        <input type="checkbox" id="cm-header"> <span>${I18n.t('First row names the columns')}</span>
      </label>
      <div class="row" style="gap:8px;margin-bottom:6px">
        <label class="set-hint" style="margin:0;min-width:90px" for="cm-first">${I18n.t('Name')}</label>
        <select id="cm-first" class="grow"></select>
      </div>
      <div class="row" style="gap:8px;margin-bottom:6px">
        <label class="set-hint" style="margin:0;min-width:90px" for="cm-last">${I18n.t('Surname')}</label>
        <select id="cm-last" class="grow"></select>
      </div>
      <div class="row" style="gap:8px;margin-bottom:10px">
        <label class="set-hint" style="margin:0;min-width:90px" for="cm-email">${I18n.t('E-mail')}</label>
        <select id="cm-email" class="grow"></select>
      </div>
      <div class="set-hint" style="margin:0 0 4px">${I18n.t('Name and Surname are joined with a space. Leave one empty if the file keeps the whole name in one column.')}</div>
      <div id="cm-preview"></div>`;

    // Read back out of the dialog rather than kept in a variable: the selects
    // ARE the state, and rebuilding them on a header toggle must not have to
    // remember to write it back somewhere as well.
    const readMap = (root) => ({
      first: +root.querySelector('#cm-first').value,
      last: +root.querySelector('#cm-last').value,
      email: +root.querySelector('#cm-email').value,
    });

    const result = await Dialog.form(I18n.t('Import contacts from CSV'), bodyHtml, {
      okLabel: I18n.t('Import'),
      wide: true,
      getValue: (root) => ({ ...readMap(root), hasHeader: root.querySelector('#cm-header').checked }),
      onOpen: (root) => {
        const headerBox = root.querySelector('#cm-header');
        headerBox.checked = hasHeader;
        const ok = root.querySelector('.dialog-buttons .send-btn');

        // Rebuilds the three dropdowns and re-guesses. Called once at open and
        // again whenever the header checkbox flips — which changes both what
        // the columns are called and which rows are data, so the old guess is
        // not worth keeping. Everything in between is the user's own choice and
        // only ever redraws the preview (see draw).
        const fill = () => {
          const header = hasHeader ? rows[0] : [];
          const dataRows = hasHeader ? rows.slice(1) : rows;
          const guess = {
            first: guessColumn(header, CT_COL_FIRST),
            last: guessColumn(header, CT_COL_LAST),
            email: guessEmailColumn(header, dataRows),
          };
          if (guess.first === -1 && guess.last === -1) {
            guess.first = guessNameColumn(dataRows, guess.email, width);
          }
          for (const field of ['first', 'last', 'email']) {
            const select = root.querySelector(`#cm-${field}`);
            const chosen = guess[field];
            select.innerHTML = `<option value="-1">— ${I18n.t('none')} —</option>`
              + [...Array(width).keys()].map((i) =>
                `<option value="${i}"${i === chosen ? ' selected' : ''}>${esc(columnLabel(i, header, dataRows, hasHeader))}</option>`).join('');
          }
          draw();
        };

        const draw = () => {
          const dataRows = hasHeader ? rows.slice(1) : rows;
          const mapped = mappedRows(dataRows, readMap(root));
          root.querySelector('#cm-count').textContent =
            `${dataRows.length} ${I18n.t('rows')} · ${I18n.t('separator')} “${delimiterName}”`;
          // Disabled rather than "Import" followed by a complaint: with no
          // e-mail column there is nothing this button could do.
          ok.disabled = !mapped.length;
          root.querySelector('#cm-preview').innerHTML = mapped.length
            ? `<div class="set-hint" style="margin:0 0 4px">${I18n.t('Will import')} ${mapped.length} ${I18n.t('of')} ${dataRows.length}${
              mapped.length < dataRows.length ? ` — ${I18n.t('rows with no e-mail address are skipped')}` : ''}</div>
              <table class="cm-preview-table">
                <thead><tr><th>${I18n.t('Name')}</th><th>${I18n.t('E-mail')}</th></tr></thead>
                <tbody>${mapped.slice(0, 5).map((r) =>
                  `<tr><td>${esc(r.name) || `<span class="set-hint" style="margin:0">${I18n.t('(no name)')}</span>`}</td><td>${esc(r.email)}</td></tr>`).join('')}</tbody>
              </table>`
            : `<div class="set-hint" style="margin:0">${I18n.t('Nothing to import yet — pick the column that holds the e-mail address.')}</div>`;
        };

        headerBox.addEventListener('change', () => { hasHeader = headerBox.checked; fill(); });
        for (const field of ['first', 'last', 'email']) {
          root.querySelector(`#cm-${field}`).addEventListener('change', draw);
        }
        fill();
      },
    });
    if (!result) return;

    const dataRows = result.hasHeader ? rows.slice(1) : rows;
    const toAdd = mappedRows(dataRows, result);
    if (!toAdd.length) return;
    try {
      const r = await API.addContacts(toAdd);
      // Three numbers, because they answer three different questions: what the
      // file held, what was new, and what was already here. "Imported 0" on its
      // own reads as a failure when it usually means the opposite.
      const already = toAdd.length - r.added;
      toast(`${I18n.t('Imported')} ${r.added} ${I18n.t('contact(s)')}${
        already ? ` — ${already} ${I18n.t('already in your contacts')}` : ''}`, 5000);
      await adoptImportedContacts();
      contactSuggestions = null;   // some suggestions are real contacts now
      renderContacts();
    } catch (e) {
      toast(I18n.t('Could not add contacts: ') + e.message, 5000);
    }
  }

  function renderContacts() {
    const ewsAccounts = allAccounts().filter((a) => a.type === 'ews' && !a.disabled);
    const graphAccounts = allAccounts().filter((a) => a.type === 'graph' && !a.disabled);
    const matches = filteredContacts();
    // A few thousand contacts is a few thousand pairs of <input>s — enough to
    // make the tab visibly slow to open and to type in, which is what the page
    // size is really protecting. `0` means the user has decided their address
    // book is small enough not to need it.
    const per = ctPageSize || Math.max(matches.length, 1);
    const pages = Math.max(1, Math.ceil(matches.length / per));
    // Deleting the last row of the last page, or narrowing the filter, leaves
    // ctPage pointing past the end — clamp rather than draw an empty page.
    if (ctPage > pages - 1) ctPage = pages - 1;
    const from = ctPage * per;
    const shown = matches.slice(from, from + per);
    const pager = ctPagerHtml(matches.length, from + 1, from + shown.length, pages);
    const selectedCount = ctSelected.size;
    body().innerHTML = `
      <p>
        <button class="link-btn" id="ct-add">+ Add contact</button>
        <button class="link-btn" id="ct-import">Import (Google CSV / vCard)</button>
        <input type="file" id="ct-file" accept=".csv,.vcf,.txt" hidden>
        ${ewsAccounts.length ? `<button class="link-btn" id="ct-ews">${I18n.t('Import from Exchange')}</button>
          ${ewsAccounts.length > 1 ? sel('ct-ews-account', ewsAccounts.map((a) => [a.id, a.label]), ewsAccounts[0].id) : ''}` : ''}
        ${graphAccounts.length ? `<button class="link-btn" id="ct-graph">${I18n.t('Import from Microsoft')}</button>
          ${graphAccounts.length > 1 ? sel('ct-graph-account', graphAccounts.map((a) => [a.id, a.label]), graphAccounts[0].id) : ''}` : ''}
        <span class="set-hint" id="ct-import-status" style="margin:0"></span>
      </p>
      <div class="card" id="ct-groups" style="margin-bottom:14px"></div>
      <div class="card" id="ct-sources" style="margin-bottom:14px"></div>
      <div class="card" style="margin-bottom:14px">
        <label class="mini-toggle" style="gap:6px">${chk('ct-autoadd', draft.autoAddContacts !== false)} <span>${I18n.t('Add people I send to')}</span></label>
        <div class="set-hint">${I18n.t('Every recipient of a message you send is saved here, unless they already are.')}</div>
        <label class="mini-toggle" style="gap:6px">${chk('ct-learnnames', draft.learnContactNames !== false)} <span>${I18n.t('Learn names from incoming mail')}</span></label>
        <div class="set-hint">${I18n.t('When someone already in this list writes to you, their display name fills in the blank one. Never adds anybody, and never replaces a name you have typed.')}</div>
      </div>
      <div class="card" id="ct-suggest-card" hidden style="margin-bottom:14px"></div>
      <div class="row" style="gap:8px;margin-bottom:10px">
        <input id="ct-search" class="grow" type="search" placeholder="${escAttr(I18n.t('Search contacts'))}" value="${escAttr(ctSearch)}" autocomplete="off">
        <span class="set-hint" style="margin:0">${matches.length}${matches.length !== contacts.length ? ` / ${contacts.length}` : ''}</span>
      </div>
      <div class="row" style="gap:8px;margin-bottom:10px">
        <label class="set-hint" style="margin:0" for="ct-sort">${I18n.t('Sort')}</label>
        ${sel('ct-sort', CT_SORTS.map(([v, l]) => [v, I18n.t(l)]), ctSort)}
        <label class="set-hint" style="margin:0" for="ct-filter">${I18n.t('Show')}</label>
        ${sel('ct-filter', CT_FILTERS.map(([v, l]) => [v, I18n.t(l)]), ctFilter)}
        ${ctFilter || ctSearch ? `<button type="button" class="link-btn" id="ct-reset-view">${I18n.t('Reset')}</button>` : ''}
        <span class="spacer"></span>
        <label class="set-hint" style="margin:0" for="ct-per">${I18n.t('Per page')}</label>
        ${sel('ct-per', CT_PAGE_SIZES.map((n) => [String(n), n ? String(n) : I18n.t('All')]), String(ctPageSize))}
      </div>
      <div class="row" style="gap:8px;margin-bottom:10px">
        <label class="mini-toggle" style="gap:6px"
          title="${escAttr(I18n.t('✕ deletes at once, without asking. Nothing is written until you press Save, so closing Settings without saving undoes the lot.'))}">
          ${chk('ct-quickdel', ctQuickDelete)} <span>${I18n.t('Quick delete')}</span>
        </label>
        <span class="set-hint" style="margin:0">${I18n.t('✕ deletes at once — undone by closing Settings without saving. Remembered for this browser.')}</span>
      </div>
      <div class="row" style="gap:8px;margin-bottom:10px">
        <label class="mini-toggle" style="gap:6px"><input type="checkbox" id="ct-all" ${shown.length && shown.every((c) => ctSelected.has(c.id)) ? 'checked' : ''}> <span>${pages > 1 ? I18n.t('Select page') : I18n.t('Select')}</span></label>
        ${matches.length > shown.length ? `<button type="button" class="link-btn" id="ct-select-matching">${I18n.t('Select all matching')} (${matches.length})</button>` : ''}
        ${selectedCount ? `<span class="set-hint" style="margin:0">${selectedCount} ${I18n.t('selected')}</span>
          <button type="button" class="link-btn" id="ct-clear-sel">${I18n.t('Clear selection')}</button>
          <button type="button" class="link-btn" id="ct-to-group">${I18n.t('Add to group')}</button>
          <span class="spacer"></span>
          <button type="button" class="btn-sm danger" id="ct-del-sel">${I18n.t('Delete selected')}</button>` : ''}
      </div>
      ${pager}
      <div class="card-list" id="ct-list">
      ${shown.map((c) => contactRowHtml(c)).join('')}
      </div>
      ${pager}
      ${!matches.length ? `<p class="set-hint" style="grid-column:auto">${
        !contacts.length ? I18n.t('No contacts yet — add one, or import them above.')
          : ctFilter ? I18n.t('No contacts match this filter.')
            : I18n.t('No contacts match your search.')}</p>` : ''}`;

    const search = document.getElementById('ct-search');
    search.addEventListener('input', () => {
      collectContacts();
      ctSearch = search.value;
      ctPage = 0;          // page 3 of the old result set means nothing in the new one
      renderContacts();
      // Re-rendering blows the focused element away — put the caret back so
      // typing a second character doesn't need a second click.
      const s2 = document.getElementById('ct-search');
      s2.focus();
      s2.setSelectionRange(s2.value.length, s2.value.length);
    });

    // collectContacts() before each: re-rendering rebuilds every <input>, so an
    // edit that has not left its field yet is only in the DOM until it is read
    // back into the draft.
    document.getElementById('ct-sort').addEventListener('change', (e) => {
      collectContacts();
      ctSort = e.target.value;
      ctPage = 0;
      renderContacts();
    });
    document.getElementById('ct-filter').addEventListener('change', (e) => {
      collectContacts();
      ctFilter = e.target.value;
      ctPage = 0;
      renderContacts();
    });
    document.getElementById('ct-reset-view')?.addEventListener('click', () => {
      collectContacts();
      ctFilter = '';
      ctSearch = '';
      ctPage = 0;
      renderContacts();
    });

    document.getElementById('ct-per').addEventListener('change', (e) => {
      collectContacts();
      const size = Number(e.target.value);
      // Stay where the user was reading rather than snapping to the top: the
      // row that was first on the old page is first on the new one.
      const firstRow = ctPage * (ctPageSize || 1);
      ctPageSize = CT_PAGE_SIZES.includes(size) ? size : CT_PAGE_SIZE_DEFAULT;
      ctPage = ctPageSize ? Math.floor(firstRow / ctPageSize) : 0;
      saveCtView();
      renderContacts();
    });
    document.getElementById('ct-quickdel').addEventListener('change', (e) => {
      collectContacts();
      ctQuickDelete = e.target.checked;
      saveCtView();
      renderContacts();
    });
    body().querySelectorAll('.ct-prev').forEach((b) => b.addEventListener('click', () => {
      collectContacts();
      ctPage = Math.max(0, ctPage - 1);
      renderContacts();
      body().querySelector('#ct-list')?.scrollIntoView({ block: 'start' });
    }));
    body().querySelectorAll('.ct-next').forEach((b) => b.addEventListener('click', () => {
      collectContacts();
      ctPage += 1;            // renderContacts clamps if this went past the end
      renderContacts();
      body().querySelector('#ct-list')?.scrollIntoView({ block: 'start' });
    }));

    document.getElementById('ct-add').addEventListener('click', () => {
      collectContacts();
      // A new blank row can't match an active search, so it would be added and
      // then immediately hidden — clear the filter rather than lose it on screen.
      // Same for "Same name, several addresses" and the two source filters: a
      // blank row matches none of them. "Without a name" is the one filter a
      // blank row does belong to, so that one is left alone.
      ctSearch = '';
      if (ctFilter && ctFilter !== 'noname') ctFilter = '';
      ctPage = 0;            // the new row sorts to the top, which is page one
      // unshift, not push: only the first CT_RENDER_CAP rows are ever drawn, so
      // a row appended to the end of a longer list is added to the array and
      // then not rendered at all — the button looks completely dead. Reported
      // with 212 contacts against a cap of 200. First is also simply where you
      // want to see the row you just asked for.
      contacts.unshift({ id: uid(), name: '', email: '' });
      renderContacts();
      // Nothing else on this tab announces the new row, and the list starts
      // well below the buttons that created it, so it can land off-screen.
      // Focus belongs here even on a phone — unlike a page that merely opened,
      // "+ Add contact" is an explicit request to start typing.
      const name = body().querySelector('#ct-list .card .ct-name');
      name?.scrollIntoView({ block: 'nearest' });
      name?.focus();
    });

    document.getElementById('ct-all').addEventListener('change', (e) => {
      // Local rows only. A synced row has no checkbox at all — bulk delete works
      // by filtering the local array and letting Save write it back, which for a
      // synced contact would remove it from the screen and change nothing on the
      // server it actually lives on.
      for (const c of shown.filter((x) => !x.synced)) { if (e.target.checked) ctSelected.add(c.id); else ctSelected.delete(c.id); }
      collectContacts();
      renderContacts();
    });
    document.getElementById('ct-select-matching')?.addEventListener('click', () => {
      for (const c of matches.filter((x) => !x.synced)) ctSelected.add(c.id);
      collectContacts();
      renderContacts();
    });
    document.getElementById('ct-clear-sel')?.addEventListener('click', () => {
      ctSelected.clear();
      collectContacts();
      renderContacts();
    });
    document.getElementById('ct-to-group')?.addEventListener('click', addSelectedToGroup);
    body().querySelectorAll('.ct-pick').forEach((b) => b.addEventListener('change', () => {
      if (b.checked) ctSelected.add(b.dataset.id); else ctSelected.delete(b.dataset.id);
      // Repaint for the count/Delete button, keeping any in-progress field edits.
      collectContacts();
      renderContacts();
    }));
    document.getElementById('ct-del-sel')?.addEventListener('click', async () => {
      const n = ctSelected.size;
      if (!await Dialog.confirm(
        `${I18n.t('Delete')} ${n} ${I18n.t('selected contact(s)?')}`,
        { title: I18n.t('Delete'), okLabel: I18n.t('Delete'), danger: true })) return;
      collectContacts();
      contacts = contacts.filter((c) => !ctSelected.has(c.id));
      ctSelected.clear();
      renderContacts();
    });

    body().querySelectorAll('.ct-del').forEach((b, i) => b.addEventListener('click', async () => {
      // Quick delete skips the question, and only for LOCAL rows: this deletes
      // out of the draft, so Save is still the thing that makes it real and
      // closing Settings without saving puts everything back. The synced ✕
      // below always asks, because that one is an immediate write to somebody
      // else's server with no draft in front of it and no undo behind it.
      if (!ctQuickDelete
        && !await Dialog.confirm(I18n.t('Delete this contact?'), { title: I18n.t('Delete'), okLabel: I18n.t('Delete'), danger: true })) return;
      collectContacts();
      contacts = contacts.filter((c) => c.id !== b.dataset.id);
      ctSelected.delete(b.dataset.id);
      renderContacts();
      // Going through a few hundred rows deleting the dead ones means clicking
      // ✕, having the list close up under the pointer, and aiming again. The
      // row that moved up into this one's place takes the focus, so the rest of
      // the pass can be done from the keyboard.
      if (!ctQuickDelete) return;
      const rest = body().querySelectorAll('#ct-list .ct-del');
      const next = rest[Math.min(i, rest.length - 1)];
      next?.focus();
      next?.scrollIntoView({ block: 'nearest' });
    }));
    document.getElementById('ct-import').addEventListener('click', () => document.getElementById('ct-file').click());
    document.getElementById('ct-file').addEventListener('change', async (e) => {
      const f = e.target.files[0];
      // Cleared whatever happens, or picking the SAME file again fires no
      // change event — which is precisely what you do after a mapping you got
      // wrong the first time.
      e.target.value = '';
      if (!f) return;
      const text = await f.text();
      if (text.trimStart().startsWith('BEGIN:VCARD')) {
        // A vCard says what each field is; there is nothing to map.
        const r = await API.importContacts(text);
        toast(`${I18n.t('Imported')} ${r.added} ${I18n.t('contact(s)')}`);
        await adoptImportedContacts();
        renderContacts();
        return;
      }
      await importCsvWithMapping(text, f.name);
    });

    // ---- Exchange: pull the account's own Contacts folder (read-only) ----
    document.getElementById('ct-ews')?.addEventListener('click', async () => {
      const status = document.getElementById('ct-import-status');
      const pick = document.getElementById('ct-ews-account');
      const accountId = pick ? pick.value : ewsAccounts[0].id;
      status.textContent = I18n.t('Importing…');
      try {
        const r = await API.importContactsFromEws(accountId);
        // `found` counts what Exchange returned, `added` what was actually new —
        // reporting both is the difference between "it did nothing" and "you
        // already had all of them".
        status.textContent = '';
        toast(`${I18n.t('Imported')} ${r.added}/${r.found} ${I18n.t('contact(s) from Exchange')}`);
        await adoptImportedContacts();
        contactSuggestions = null; // some suggestions may now be real contacts
        renderContacts();
      } catch (err) {
        status.textContent = '';
        toast(I18n.t('Exchange import failed: ') + err.message, 6000);
      }
    });

    // ---- Microsoft: pull the account's own Contacts (read-only) ----
    document.getElementById('ct-graph')?.addEventListener('click', async () => {
      const status = document.getElementById('ct-import-status');
      const pick = document.getElementById('ct-graph-account');
      const accountId = pick ? pick.value : graphAccounts[0].id;
      status.textContent = I18n.t('Importing…');
      try {
        const r = await API.importContactsFromGraph(accountId);
        status.textContent = '';
        toast(`${I18n.t('Imported')} ${r.added}/${r.found} ${I18n.t('contact(s) from Microsoft')}`);
        await adoptImportedContacts();
        contactSuggestions = null; // some suggestions may now be real contacts
        renderContacts();
      } catch (err) {
        status.textContent = '';
        toast(I18n.t('Microsoft import failed: ') + err.message, 6000);
      }
    });

    // ---- synced rows: their own delete, and commit-on-blur ----
    body().querySelectorAll('.ct-del-synced').forEach((b) => b.addEventListener('click', async () => {
      if (!await Dialog.confirm(
        I18n.t('Delete this contact from the server it is synced with?'),
        { title: I18n.t('Delete'), okLabel: I18n.t('Delete'), danger: true })) return;
      try {
        const r = await API.deleteContact(b.dataset.id);
        contacts = r.contacts;
        state.contacts = structuredClone(contacts);
        renderContacts();
      } catch (e) { toast(e.message, 8000); }
    }));
    // `change`, not `input`: each one is a write to somebody else's server, and
    // one per keystroke would be both slow and a good way to get rate-limited.
    body().querySelectorAll('#ct-list .card[data-synced] input').forEach((el) => {
      el.addEventListener('change', () => commitSyncedRow(el.closest('.card')));
    });

    // ---- groups ----
    renderGroupsCard();

    // ---- synced address books ----
    renderContactSources();
    if (ctSources === null) loadContactSources().then(renderContactSources);

    // ---- Suggestions from mail history ----
    renderSuggestions();
    if (contactSuggestions === null) {
      API.contactSuggestions()
        .then((r) => { contactSuggestions = r.suggestions || []; renderSuggestions(); })
        .catch(() => { contactSuggestions = []; });
    }
  }

  /** Paints the "People you write to" card, or hides it when there's nothing to
   * suggest (a fresh install with an empty cache, or every correspondent
   * already saved). Collapsed by default now that it sits at the top of the tab
   * — the point of moving the import controls up was to keep the contact list
   * itself within reach, which a long suggestion list would undo. */
  function renderSuggestions() {
    const card = document.getElementById('ct-suggest-card');
    if (!card) return;
    if (!contactSuggestions?.length) { card.hidden = true; return; }
    card.hidden = false;
    card.innerHTML = `
      <div class="row" style="margin-bottom:${ctSuggestOpen ? '8px' : '0'}">
        <b>${I18n.t('People you write to')}</b>
        <span class="set-hint" style="margin:0 0 0 8px">${contactSuggestions.length}</span>
        <span class="spacer"></span>
        <button type="button" class="link-btn" id="ct-sug-toggle">${ctSuggestOpen ? I18n.t('Hide') : I18n.t('Show')}</button>
      </div>
      ${ctSuggestOpen ? `
      <p class="set-hint" style="grid-column:auto;margin:0 0 10px">${I18n.t('Found in your synced mail and not in your contacts yet — the ones you have actually written to are ticked. Nothing is added until you press the button.')}</p>
      <div class="row" style="gap:6px;margin-bottom:8px">
        <button type="button" class="link-btn" id="ct-sug-all">${I18n.t('Select all')}</button>
        <button type="button" class="link-btn" id="ct-sug-none">${I18n.t('Select none')}</button>
      </div>
      <div class="card-list" id="ct-suggest-list"></div>
      <p><button class="btn-sm" id="ct-sug-add">${I18n.t('Add selected contacts')}</button></p>` : ''}`;

    document.getElementById('ct-sug-toggle').onclick = () => { ctSuggestOpen = !ctSuggestOpen; renderSuggestions(); };
    if (!ctSuggestOpen) return;

    const list = document.getElementById('ct-suggest-list');
    list.innerHTML = contactSuggestions.map((c, i) => `<div class="card"><div class="row">
      <label class="mini-toggle" style="gap:8px">
        <input type="checkbox" class="ct-sug" data-i="${i}" ${c.sent ? 'checked' : ''}>
        <span>${esc(c.name || c.email)}</span>
      </label>
      <span class="set-hint" style="margin:0 0 0 8px">${esc(c.email)}</span>
      <span class="spacer"></span>
      <span class="set-hint" style="margin:0">${c.sent ? `${I18n.t('sent')} ${c.sent}` : ''}${c.sent && c.received ? ' · ' : ''}${c.received ? `${I18n.t('received')} ${c.received}` : ''}</span>
    </div></div>`).join('');

    const boxes = () => [...list.querySelectorAll('.ct-sug')];
    document.getElementById('ct-sug-all').onclick = () => boxes().forEach((b) => { b.checked = true; });
    document.getElementById('ct-sug-none').onclick = () => boxes().forEach((b) => { b.checked = false; });
    document.getElementById('ct-sug-add').onclick = async () => {
      const rows = boxes().filter((b) => b.checked)
        .map((b) => contactSuggestions[+b.dataset.i])
        .map((c) => ({ name: c.name, email: c.email }));
      if (!rows.length) return;
      try {
        const r = await API.addContacts(rows);
        toast(`${I18n.t('Added')} ${r.added} ${I18n.t('contact(s)')}`);
        await adoptImportedContacts();
        contactSuggestions = null; // the added ones are contacts now — refetch what's left
        renderContacts();
      } catch (e) { toast(I18n.t('Could not add contacts: ') + e.message, 5000); }
    };
  }

  function collectContacts() {
    const byId = new Map(contacts.map((c) => [c.id, c]));
    for (const card of body().querySelectorAll('#ct-list .card')) {
      const c = byId.get(card.dataset.id);
      if (!c) continue;
      // A synced row is committed to its own server as it is edited (see
      // commitSyncedRow), not gathered here — reading its inputs into the draft
      // would mean Save quietly took a copy of somebody else's address book.
      if (c.synced) continue;
      c.name = card.querySelector('.ct-name').value.trim();
      c.email = card.querySelector('.ct-email').value.trim();
    }
    // Blank rows are dropped, synced ones never are: an empty synced row cannot
    // exist (the server would not have sent it) and filtering on `email` alone
    // would delete one the moment a search hid it mid-edit.
    contacts = contacts.filter((c) => c.synced || c.email);
    // The group name inputs sit on this same tab and are drafted the same way.
    collectGroups();
    // The two address-book upkeep toggles are ordinary settings that happen to
    // live on this tab, so they ride along in `draft` like every other one —
    // save() writes settings and contacts in the same pass.
    const g = (id) => document.getElementById(id);
    if (g('ct-autoadd')) draft.autoAddContacts = g('ct-autoadd').checked;
    if (g('ct-learnnames')) draft.learnContactNames = g('ct-learnnames').checked;
  }

  /* ---------- admin: Hmelj login accounts (not mail accounts) ---------- */

  let adminUsers = [];
  let adminSettings = { allowSignup: true };
  let adminPresets = [];
  let adminOAuth = [];
  let adminFonts = [];

  function userRow(u) {
    return `<div class="card" data-uid="${u.id}">
      <div class="row">
        <b>${esc(u.displayUsername || u.username)}</b>
        ${u.isAdmin ? '<span class="set-hint" style="margin:0">admin</span>' : ''}
        ${u.disabled ? '<span class="set-hint" style="margin:0;color:var(--danger)">disabled</span>' : ''}
        <span class="spacer"></span>
        <button class="link-btn au-toggle">${u.disabled ? 'Enable' : 'Disable'}</button>
        <button class="link-btn au-del" style="color:var(--danger)">Remove</button>
      </div>
    </div>`;
  }

  function presetRow(p) {
    // Name, server info, and the Edit/Remove buttons each get their own row
    // unconditionally — sharing one flex row and only wrapping incidentally
    // when the text was long enough made the layout inconsistent from one
    // preset to the next.
    return `<div class="card" data-pid="${p.id}">
      <div class="row"><b>${esc(p.name)}</b></div>
      <div class="row"><span class="set-hint" style="margin:0">${esc(p.imapHost)}:${p.imapPort} / ${esc(p.smtpHost)}:${p.smtpPort}</span></div>
      <div class="row">
        <button class="link-btn ap-edit">Edit</button>
        <button class="link-btn ap-del" style="color:var(--danger)">Remove</button>
      </div>
    </div>`;
  }

  /**
   * One OAuth provider's client registration. The redirect URI is shown
   * read-only and prominently because it has to be registered with the provider
   * byte for byte — and, for Microsoft, under the right platform, which is the
   * other half of the same trap, since the same URI registered as "Web" makes
   * Azure demand a client secret.
   *
   * The two providers differ on exactly that point, which is why the secret
   * field is conditional (server/oauth.js decides, via `usesSecret`): Microsoft
   * is registered as a PUBLIC client and proves itself with PKCE, while Google's
   * only server-side redirect flow is the "Web application" client, which is
   * confidential and requires its secret. The stored secret is never sent back
   * here — the field shows whether one exists and follows the same "blank means
   * keep it" rule as every password field in Hmelj.
   */
  function oauthProviderRow(p) {
    const setupHelp = p.id === 'google'
      ? I18n.t('In the Google Cloud console: APIs & Services → Credentials → Create credentials → OAuth client ID → application type "Web application", and paste this URI under Authorized redirect URIs. On the OAuth consent screen add the scope https://mail.google.com/ — and set the publishing status to "In production", otherwise Google expires the sign-in every 7 days. Verification is not needed for your own use; users just click through an "unverified app" warning once.')
      : I18n.t('In Azure register this under Authentication → Add a platform → "Mobile and desktop applications" → Custom redirect URIs. Registering it as "Web" instead makes Microsoft demand a client secret, which Hmelj does not use.');
    return `<div class="card" data-oap="${escAttr(p.id)}">
      <div class="row"><b>${esc(p.label)}</b>
        <span class="spacer"></span>
        <span class="set-hint" style="margin:0">${p.configured ? '✓ ' + I18n.t('Configured') : I18n.t('Not configured')}</span>
      </div>
      <div class="row"><span class="set-hint" style="margin:0">${I18n.t('Redirect URI to register with the provider')}:</span></div>
      <div class="row"><input class="oa-redirect" value="${escAttr(p.redirectUri)}" readonly onclick="this.select()" style="flex:1"></div>
      <div class="row"><span class="set-hint" style="margin:0">${setupHelp}</span></div>
      ${p.envManaged ? `<div class="row"><span class="set-hint" style="margin:0">${I18n.t('Set by environment variables — edit those and restart to change it.')}</span></div>` : `
      <div class="row"><label style="flex:1">${I18n.t('Client ID')}<input class="oa-clientid" value="${escAttr(p.clientId)}" placeholder="${p.id === 'google' ? '…apps.googleusercontent.com' : '00000000-0000-0000-0000-000000000000'}"></label></div>
      ${p.usesSecret ? `<div class="row"><label style="flex:1">${I18n.t('Client secret')}<input class="oa-clientsecret" type="password" autocomplete="new-password" placeholder="${p.hasSecret ? I18n.t('(unchanged)') : 'GOCSPX-…'}"></label></div>` : ''}
      ${p.usesTenant ? `<div class="row"><label style="flex:1">${I18n.t('Tenant')}<input class="oa-tenant" value="${escAttr(p.tenant)}" placeholder="common"></label></div>` : ''}
      <div class="row"><span class="set-hint" style="margin:0">${p.usesTenant ? I18n.t('Use "common" unless you registered a single-tenant app.') : ''}</span>
        <span class="spacer"></span><button class="btn-sm oa-save">${I18n.t('Save')}</button></div>`}
    </div>`;
  }

  /** Guesses {family, style} from a font filename — "Bookerly-Regular.ttf",
   * "Bookerly-BoldItalic.ttf", "Bookerly Bold Italic.otf", "Bookerly_Bold.woff2"
   * all resolve correctly. Splits on space/hyphen/underscore, additionally
   * splitting a single joined "BoldItalic"/"ItalicBold" token into its two
   * parts, then pulls out any recognized style keyword — whatever tokens are
   * left (in their original order) become the family name. */
  function parseFontFilename(filename) {
    const base = String(filename || '').replace(/\.(ttf|otf|woff2?)$/i, '');
    const rawTokens = base.split(/[\s_-]+/).filter(Boolean);
    const tokens = [];
    for (const t of rawTokens) {
      const lower = t.toLowerCase();
      if (lower === 'bolditalic' || lower === 'italicbold') tokens.push('Bold', 'Italic');
      else tokens.push(t);
    }
    const styleSet = new Set();
    const familyTokens = [];
    for (const t of tokens) {
      const lower = t.toLowerCase();
      if (lower === 'bold') styleSet.add('bold');
      else if (lower === 'italic' || lower === 'oblique') styleSet.add('italic');
      else if (lower === 'regular' || lower === 'normal' || lower === 'roman' || lower === 'book') styleSet.add('regular');
      else familyTokens.push(t);
    }
    let style = 'regular';
    if (styleSet.has('bold') && styleSet.has('italic')) style = 'boldItalic';
    else if (styleSet.has('bold')) style = 'bold';
    else if (styleSet.has('italic')) style = 'italic';
    const family = familyTokens.join(' ').trim() || base.trim();
    return { family, style };
  }

  const FONT_STYLE_LABELS = [['regular', 'Regular'], ['bold', 'Bold'], ['italic', 'Italic'], ['boldItalic', 'Bold Italic']];
  /** One uploaded-or-empty style slot: a chip with a Remove button if a file
   * is already there, otherwise a label wrapping a hidden file input (the
   * upload starts the moment a file is picked — no separate confirm step). */
  function fontStyleSlot(f, style, label) {
    const url = f.styles[style];
    return url
      ? `<span class="attach-chip">${I18n.t(label)} <button type="button" class="fnt-del-style" data-style="${style}" title="${I18n.t('Remove')}">✕</button></span>`
      : `<label class="link-btn fnt-add-style">+ ${I18n.t(label)}<input type="file" accept=".ttf,.otf,.woff,.woff2" class="fnt-file-input" data-style="${style}" hidden></label>`;
  }
  function fontFamilyRow(f) {
    return `<div class="card" data-fid="${f.id}">
      <div class="row"><b>${esc(f.family)}</b><span class="spacer"></span>
        <button class="link-btn fnt-del-family" style="color:var(--danger)">${I18n.t('Remove family')}</button></div>
      <div class="row">${FONT_STYLE_LABELS.map(([style, label]) => fontStyleSlot(f, style, label)).join('')}</div>
    </div>`;
  }

  /** Add/edit one account preset. Resolves the saved preset, or null on cancel. */
  async function presetEditor(p = null) {
    const v = (x, d = '') => escAttr(x ?? d);
    const bodyHtml = `<div class="wiz-grid">
      <div class="full"><label>Name</label><input id="pe-name" value="${v(p?.name)}" placeholder="My provider"></div>
      <div><label>IMAP server</label><input id="pe-ihost" value="${v(p?.imapHost)}" placeholder="imap.example.com"></div>
      <div><label>Port</label><input id="pe-iport" type="number" value="${v(p?.imapPort, 993)}"></div>
      <div class="full"><label class="mini-toggle"><input type="checkbox" id="pe-itls" ${!p || p.imapTls !== false ? 'checked' : ''}> Use TLS (recommended)</label></div>
      <div><label>SMTP server</label><input id="pe-shost" value="${v(p?.smtpHost)}" placeholder="smtp.example.com"></div>
      <div><label>Port</label><input id="pe-sport" type="number" value="${v(p?.smtpPort, 465)}"></div>
      <div class="full"><label class="mini-toggle"><input type="checkbox" id="pe-stls" ${!p || p.smtpTls !== false ? 'checked' : ''}> Use TLS (recommended)</label></div>
      <div class="full"><label>Help text (shown to users in the wizard)</label><textarea id="pe-help" rows="2" style="width:100%">${esc(p?.helpText || '')}</textarea></div>
      <div class="full"><label>Help link (optional)</label><input id="pe-helpurl" value="${v(p?.helpUrl)}" placeholder="https://…"></div>
    </div>`;
    const root = await Dialog.form(p ? 'Edit preset' : 'Add preset', bodyHtml, { okLabel: I18n.t('Save'), wide: true, getValue: (r) => r });
    if (!root) return null;
    const g = (id) => root.querySelector('#' + id);
    const input = {
      name: g('pe-name').value.trim(),
      imapHost: g('pe-ihost').value.trim(), imapPort: +g('pe-iport').value || 993, imapTls: g('pe-itls').checked,
      smtpHost: g('pe-shost').value.trim(), smtpPort: +g('pe-sport').value || 465, smtpTls: g('pe-stls').checked,
      helpText: g('pe-help').value.trim(), helpUrl: g('pe-helpurl').value.trim(),
    };
    if (!input.name) { toast('Preset name is required'); return null; }
    return API.adminSavePreset(input, p?.id);
  }

  async function renderAdmin() {
    body().innerHTML = `<p class="set-hint" style="grid-column:auto">Loading…</p>`;
    [adminUsers, adminSettings, adminPresets, adminOAuth, adminFonts] = await Promise.all([API.adminUsers(), API.adminSettings(), API.presets(), API.adminOAuth().catch(() => []), API.fonts()]);
    body().innerHTML = `
      <div class="card-list">${adminUsers.map(userRow).join('')}</div>
      <p class="set-section" style="border:0;margin-top:20px">Sign-up</p>
      <label class="mini-toggle"><input type="checkbox" id="au-allowsignup" ${adminSettings.allowSignup ? 'checked' : ''}> Allow new users to sign up</label>
      <p class="set-section" style="border:0;margin-top:20px">${I18n.t('OAuth providers')}</p>
      <p class="set-hint" style="grid-column:auto;margin:0 0 10px">${I18n.t('Lets users add mail accounts by signing in with the provider instead of storing a password — required for Outlook.com and Microsoft 365, which no longer accept passwords for IMAP/SMTP, and the alternative to an app password for Gmail. Register an application with the provider, then paste its client ID (and, for Google, its client secret) here. Each provider says below exactly how it has to be registered.')}</p>
      <div class="card-list">${adminOAuth.map(oauthProviderRow).join('')}</div>
      <p class="set-section" style="border:0;margin-top:20px">Account presets</p>
      <div class="card-list">${adminPresets.map(presetRow).join('')}</div>
      <p><button class="link-btn" id="ap-add">+ Add preset</button></p>
      <p class="set-section" style="border:0;margin-top:20px">${I18n.t('Custom fonts')}</p>
      <p class="set-hint" style="grid-column:auto;margin:0 0 10px">${I18n.t('Available to every user in the App font / Message font pickers. Select multiple TTF/OTF/WOFF/WOFF2 files at once (e.g. Bookerly-Regular.ttf, Bookerly-Bold.ttf) — family name and style are detected from each filename automatically.')}</p>
      <div class="card-list" id="fnt-list">${adminFonts.map(fontFamilyRow).join('')}</div>
      <p><button class="link-btn" id="fnt-add-family">+ ${I18n.t('Add font family')}</button></p>`;

    body().querySelectorAll('.oa-save').forEach((b) => b.addEventListener('click', async () => {
      const card = b.closest('[data-oap]');
      try {
        await API.adminSaveOAuth(card.dataset.oap, {
          // Trimmed because an ID pasted out of the Azure portal can pick up a
          // trailing space, and the failure that produces is a whole browser
          // sign-in away and reads as "application not found".
          clientId: card.querySelector('.oa-clientid').value.trim(),
          // Absent for a provider that has no tenant/secret concept; a blank
          // secret means "keep the stored one" (the field is never prefilled,
          // because the server never sends it back).
          ...(card.querySelector('.oa-tenant') ? { tenant: card.querySelector('.oa-tenant').value.trim() } : {}),
          ...(card.querySelector('.oa-clientsecret')?.value ? { clientSecret: card.querySelector('.oa-clientsecret').value.trim() } : {}),
        });
        toast(I18n.t('Saved') + ' ✓');
        renderAdmin();
      } catch (e) { toast(e.message); }
    }));

    body().querySelectorAll('.au-toggle').forEach((b) => b.addEventListener('click', async () => {
      const id = b.closest('[data-uid]').dataset.uid;
      const u = adminUsers.find((x) => x.id === id);
      try {
        await API.adminSetUserDisabled(id, !u.disabled);
        renderAdmin();
      } catch (e) { toast(e.message); }
    }));
    body().querySelectorAll('.au-del').forEach((b) => b.addEventListener('click', async () => {
      const id = b.closest('[data-uid]').dataset.uid;
      const u = adminUsers.find((x) => x.id === id);
      if (!await Dialog.confirm(`Remove user "${u.displayUsername || u.username}"? Their mail account settings stay on disk but they can no longer sign in.`, { title: 'Remove', okLabel: 'Remove' })) return;
      try {
        await API.adminDeleteUser(id);
        renderAdmin();
      } catch (e) { toast(e.message); }
    }));
    document.getElementById('au-allowsignup').addEventListener('change', async (e) => {
      try { adminSettings = await API.adminSetAllowSignup(e.target.checked); }
      catch (err) { toast(err.message); e.target.checked = !e.target.checked; }
    });
    document.getElementById('ap-add').addEventListener('click', async () => {
      if (await presetEditor(null)) renderAdmin();
    });
    body().querySelectorAll('.ap-edit').forEach((b) => b.addEventListener('click', async () => {
      const id = b.closest('[data-pid]').dataset.pid;
      if (await presetEditor(adminPresets.find((x) => x.id === id))) renderAdmin();
    }));
    body().querySelectorAll('.ap-del').forEach((b) => b.addEventListener('click', async () => {
      const id = b.closest('[data-pid]').dataset.pid;
      if (!await Dialog.confirm('Remove this preset?', { title: 'Remove', okLabel: 'Remove' })) return;
      await API.adminDeletePreset(id);
      renderAdmin();
    }));

    // Custom fonts — a fresh copy of the list needs to reach every OTHER
    // open session too (not just this Admin tab), since the App font/Message
    // font pickers read from state.customFonts on the main window — see
    // refreshCustomFonts() in app.js.
    const fontsChanged = async () => { await renderAdmin(); await refreshCustomFonts(); };
    document.getElementById('fnt-add-family').addEventListener('click', () => {
      const input = document.createElement('input');
      input.type = 'file';
      input.multiple = true;
      input.accept = '.ttf,.otf,.woff,.woff2';
      input.addEventListener('change', async () => {
        const files = Array.from(input.files || []);
        if (!files.length) return;
        // Group by parsed family name (case-insensitive) — selecting
        // Bookerly-Regular/Bold/Italic/BoldItalic together in one go belongs
        // to one family; a batch covering several families at once works
        // the same way. Reuses an already-existing family with a matching
        // name instead of creating a confusing duplicate, so running this
        // again later to add a missing weight lands on the same family card.
        const groups = new Map(); // lowercase family -> { family, familyId, files: [{style, file}] }
        for (const file of files) {
          const { family, style } = parseFontFilename(file.name);
          const key = family.toLowerCase();
          if (!groups.has(key)) {
            const existing = adminFonts.find((f) => f.family.toLowerCase() === key);
            groups.set(key, { family: existing?.family || family, familyId: existing?.id || null, files: [] });
          }
          groups.get(key).files.push({ style, file });
        }
        let failed = 0;
        for (const g of groups.values()) {
          for (const { style, file } of g.files) {
            try {
              const entry = await API.adminUploadFont(g.familyId, g.family, style, file);
              g.familyId = entry.id;
            } catch (e) { failed++; toast(`${g.family} (${I18n.t(FONT_STYLE_LABELS.find(([s]) => s === style)?.[1] || style)}): ${e.message}`); }
          }
        }
        await fontsChanged();
        if (!failed) toast(I18n.t('Font(s) added'));
      });
      input.click();
    });
    body().querySelectorAll('.fnt-file-input').forEach((input) => input.addEventListener('change', async () => {
      const file = input.files[0];
      if (!file) return;
      const fid = input.closest('[data-fid]').dataset.fid;
      const family = adminFonts.find((f) => f.id === fid)?.family;
      try { await API.adminUploadFont(fid, family, input.dataset.style, file); await fontsChanged(); }
      catch (e) { toast(e.message); }
    }));
    body().querySelectorAll('.fnt-del-style').forEach((b) => b.addEventListener('click', async () => {
      const fid = b.closest('[data-fid]').dataset.fid;
      try { await API.adminDeleteFontStyle(fid, b.dataset.style); await fontsChanged(); }
      catch (e) { toast(e.message); }
    }));
    body().querySelectorAll('.fnt-del-family').forEach((b) => b.addEventListener('click', async () => {
      const fid = b.closest('[data-fid]').dataset.fid;
      if (!await Dialog.confirm(I18n.t('Remove this font family? It will no longer be selectable by any user.'), { title: I18n.t('Remove'), okLabel: I18n.t('Remove') })) return;
      try { await API.adminDeleteFontFamily(fid); await fontsChanged(); }
      catch (e) { toast(e.message); }
    }));
  }

  /* ---------- collect & save ---------- */

  function collectCurrentTab() {
    const g = (id) => document.getElementById(id);
    switch (tab) {
      // Not a settings field but a resource list, like filters and subject
      // rules: read the typed name/query back out of the rows so the footer
      // Save picks them up from whichever tab happens to be on screen.
      case 'templates':
        collectTemplates();
        break;
      case 'saved':
        for (const card of body().querySelectorAll('[data-saved]')) {
          const sv = savedSearches.find((x) => x.id === card.dataset.saved);
          if (!sv) continue;
          sv.name = card.querySelector('.sv-name').value;
          sv.query = card.querySelector('.sv-query').value;
        }
        break;
      case 'general':
        Object.assign(draft, { language: g('s-lang').value, uiFont: g('s-uifont').value, uiFontSize: +g('s-uifontsize').value, uiFontWeight: +g('s-uiweight').value, keepScreenOn: g('s-keepawake').checked, timeFormat: g('s-time').value, dateFormat: g('s-date').value, conversationView: g('s-convview').checked, conversationExpandAll: g('s-convexpand').checked, messagesPerPage: +g('s-perpage').value, syncBackfillLimit: +g('s-backfill').value, contentCacheLimit: +g('s-contentcache').value, searchAutocomplete: g('s-searchauto').checked, searchIndexMaxMb: +g('s-ftsmax').value, runFiltersOnLoad: g('s-runfilters').checked, deleteBehavior: g('s-delmode').value, markReadOnDelete: g('s-delread').checked, desktopNotifications: g('s-notify')?.checked ?? draft.desktopNotifications, swipeGestures: g('s-swipe').checked, swipeSwapDirection: g('s-swipedir').value === 'swapped' });
        break;
      case 'offline':
        Object.assign(draft, {
          offlineEnabled: g('s-offline').checked,
          offlineMessages: +g('s-offline-count').value,
          offlineAttachments: g('s-offline-att').checked,
          offlineMaxMb: +g('s-offline-max').value,
        });
        break;
      case 'reading':
        Object.assign(draft, {
          readingPane: g('s-pane').value, autoMarkRead: g('s-amr').value, autoMarkReadDelay: +g('s-amr-delay').value,
          externalImages: g('s-ext').value, trustedDomains: g('s-trusted').value.split(/\r?\n/).map((x) => x.trim()).filter(Boolean),
          showDeleted: g('s-showdel').checked, unsubscribeButton: g('s-unsub').checked, senderAuthBadge: g('s-authbadge').checked,
          unsubscribeBannerCompact: g('s-unsub-min').checked,
          messageFont: g('s-font').value, messageFontSize: +g('s-fontsize').value,
          messageFontOverride: g('s-fontforce').checked,
        });
        break;
      case 'compose':
        Object.assign(draft, { undoSendSeconds: +g('s-undosend').value, attachmentReminder: g('s-attachwarn').checked, subjectReminder: g('s-subjectwarn').checked, replyAllNudge: g('s-replyall').checked, composeFormat: g('s-format').value, composeFont: g('s-compose-font').value, replyQuotePosition: g('s-quote').value, autosaveDraftSeconds: +g('s-autosave').value, requestReadReceipt: g('s-receipt').checked, spellcheck: g('s-spellcheck').checked });
        break;
      case 'identities': collectIdentities(); break;
      case 'filters': collectFilters(); break;
      case 'contacts': collectContacts(); break;
    }
  }

  /* ---------- Log ---------- */
  // Read-only, so it has no entry in collectCurrentTab() — nothing here is part
  // of the settings draft and pressing Save while looking at it is a no-op.
  let logPage = 1;
  let logLevel = null;
  let logData = null;            // the last page fetched, so expanding a row is instant
  const logExpanded = new Set(); // entry ids currently showing their detail

  // Category -> what to call it in the UI. Anything not listed falls through to
  // the raw category next to the method+path in the entry's own detail, so a
  // new category added server-side degrades to something readable rather than
  // to blank.
  const LOG_CATEGORY = {
    filter: 'Filters', sync: 'Account sync', send: 'Sending', flags: 'Marking read/unread',
    move: 'Moving messages', delete: 'Deleting messages', folder: 'Folders',
    account: 'Accounts', message: 'Messages', general: 'Other',
  };
  const LOG_LEVEL_ICON = { error: '⛔', warn: '⚠️', info: 'ℹ️' };

  /** Compact for the row, full for the expanded detail — a phone row has no
   *  space for a date, and "3 min ago" is the useful form anyway while the
   *  absolute time matters once you're actually investigating. */
  function logAgo(ts) {
    const secs = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (secs < 60) return I18n.t('just now');
    const mins = Math.round(secs / 60);
    if (mins < 60) return mins + ' min';
    const hours = Math.round(mins / 60);
    if (hours < 24) return hours + ' h';
    return Math.round(hours / 24) + ' d';
  }

  function logRow(e) {
    const open = logExpanded.has(e.id);
    const cat = I18n.t(LOG_CATEGORY[e.category] || e.category);
    const when = new Date(e.at);
    return `<div class="log-row ${open ? 'open' : ''}" data-log="${e.id}">
      <button class="log-head" aria-expanded="${open}">
        <span class="log-level log-${esc(e.level)}" title="${escAttr(I18n.t(e.level))}">${LOG_LEVEL_ICON[e.level] || '•'}</span>
        <span class="log-main">
          <span class="log-msg">${esc(e.message)}</span>
          <span class="log-sub">${esc(cat)}${e.accountLabel ? ' · ' + esc(e.accountLabel) : ''}</span>
        </span>
        <span class="log-when">${esc(logAgo(e.at))}${e.count > 1 ? ` <span class="log-count">×${e.count}</span>` : ''}</span>
      </button>
      ${open ? `<div class="log-detail">
        ${e.detail ? `<pre>${esc(e.detail)}</pre>` : ''}
        <div class="log-meta">
          <span>${I18n.t('Last')}: ${esc(fmtDate(when, { long: true }))}</span>
          ${e.count > 1 ? `<span>${I18n.t('First')}: ${esc(fmtDate(new Date(e.firstAt), { long: true }))}</span>` : ''}
          <span>${I18n.t('Category')}: ${esc(e.category)}</span>
        </div>
      </div>` : ''}
    </div>`;
  }

  /** Fetches a page, then paints it. Split from paintLog so expanding a row —
   *  by far the most common interaction here — is a local repaint rather than a
   *  round trip on every tap. */
  async function renderLog() {
    body().innerHTML = `<p class="set-hint" style="grid-column:auto">${I18n.t('Loading…')}</p>`;
    try {
      logData = await API.userLog({ page: logPage, level: logLevel });
    } catch (e) {
      body().innerHTML = `<p class="set-hint" style="grid-column:auto;color:var(--danger)">${esc(e.message)}</p>`;
      return;
    }
    // A page that no longer exists (the log was cleared, or entries aged out
    // while it was open) would otherwise render as a blank list with a pager
    // pointing nowhere.
    const pages = Math.max(1, Math.ceil(logData.total / logData.pageSize));
    if (logPage > pages) { logPage = pages; return renderLog(); }
    paintLog();
  }

  function paintLog() {
    const data = logData;
    if (!data) return;
    const pages = Math.max(1, Math.ceil(data.total / data.pageSize));

    const filters = [['', 'All'], ['error', 'Errors'], ['warn', 'Warnings'], ['info', 'Info']]
      .map(([v, t]) => `<option value="${v}" ${v === (logLevel || '') ? 'selected' : ''}>${I18n.t(t)}</option>`).join('');

    body().innerHTML = `
      <p class="set-hint" style="grid-column:auto;margin:0 0 10px">${I18n.t('Problems with your accounts — filters that failed, mail that could not be sent, servers that could not be reached. Tap an entry for details.')}</p>
      <div class="log-toolbar">
        <select id="log-level">${filters}</select>
        <span class="spacer"></span>
        <button class="link-btn" id="log-refresh">${I18n.t('Refresh')}</button>
        <button class="link-btn danger" id="log-clear" ${data.total ? '' : 'disabled'}>${I18n.t('Clear log')}</button>
      </div>
      ${data.entries.length
        ? `<div class="log-list">${data.entries.map(logRow).join('')}</div>`
        : `<p class="set-hint" style="grid-column:auto">${I18n.t('Nothing logged — everything has been working.')}</p>`}
      ${pages > 1 ? `<div class="log-pager">
        <button class="link-btn" id="log-prev" ${logPage <= 1 ? 'disabled' : ''}>‹</button>
        <span>${logPage} / ${pages}</span>
        <button class="link-btn" id="log-next" ${logPage >= pages ? 'disabled' : ''}>›</button>
      </div>` : ''}`;

    body().querySelectorAll('.log-head').forEach((btn) => btn.addEventListener('click', () => {
      const id = +btn.closest('.log-row').dataset.log;
      if (logExpanded.has(id)) logExpanded.delete(id); else logExpanded.add(id);
      paintLog(); // local — no refetch just to open a row
    }));
    document.getElementById('log-level')?.addEventListener('change', (e) => {
      logLevel = e.target.value || null;
      logPage = 1;
      renderLog();
    });
    document.getElementById('log-refresh')?.addEventListener('click', () => renderLog());
    document.getElementById('log-prev')?.addEventListener('click', () => { logPage--; renderLog(); });
    document.getElementById('log-next')?.addEventListener('click', () => { logPage++; renderLog(); });
    document.getElementById('log-clear')?.addEventListener('click', async () => {
      if (!await Dialog.confirm(I18n.t('Delete every entry in the log? This cannot be undone.'), { title: I18n.t('Clear log'), okLabel: I18n.t('Clear'), danger: true })) return;
      await API.clearUserLog();
      logExpanded.clear();
      logPage = 1;
      renderLog();
    });
  }

  /* ---------- Calendars tab (server/calendar/*) ----------
   *
   * Deliberately parallel to the contact-sources panel above: a source is one
   * server's worth of calendars, either a CalDAV URL with its own password or a
   * mail account whose OAuth sign-in is borrowed. Saving one has effects on
   * somebody else's server, so it happens on its own dialog's Save rather than
   * riding along on this tab's Save button — which is why none of this touches
   * `draft`. */
  let calSources = null;      // null until first fetched
  let calList = [];
  let calKinds = {};
  let calWindow = null;       // the rolling window Microsoft/Exchange are known over
  let calSyncing = new Set();
  let davInfo = null;         // what Hmelj publishes, and the URL to subscribe at

  async function loadCalendars() {
    try {
      const r = await API.calendars();
      calSources = r.sources || [];
      calList = r.calendars || [];
      calKinds = r.kinds || {};
      calWindow = r.window || null;
    } catch { calSources = []; }
  }

  /** Mail accounts whose sign-in a calendar source of this kind could borrow. */
  function calAccountsFor(kind) {
    if (kind === 'graph') return allAccounts().filter((a) => a.type === 'graph' && !a.disabled);
    if (kind === 'ews') return allAccounts().filter((a) => a.type === 'ews' && !a.disabled);
    // A Gmail account on an app password has no token to borrow, and offering
    // it would produce a source that can never authenticate.
    if (kind === 'google') return allAccounts().filter((a) => !a.disabled && a.oauth?.provider === 'google');
    return [];
  }

  /** Whether this source type is only known over a rolling window. Microsoft
   *  and Exchange expand their own recurrence rather than handing over the
   *  rules, so their calendars reach exactly as far as the window and no
   *  further — and "my appointment in 2031 is missing" deserves an answer. */
  const calWindowed = (kind) => kind === 'graph' || kind === 'ews';

  function renderCalendars() {
    if (calSources === null) {
      body().innerHTML = `<p class="set-hint">${esc(I18n.t('Loading…'))}</p>`;
      loadCalendars().then(renderCalendars);
      return;
    }
    const addable = Object.entries(calKinds)
      // 'none' is a calendar that lives in Hmelj itself — no server, nothing to
      // sign in to, so it is always offerable.
      .filter(([kind, meta]) => meta.credentials === 'none' || meta.credentials === 'own' || calAccountsFor(kind).length);
    // Named from the server's own descriptors rather than listed here, so this
    // says nothing when every kind is writable (which it now is) and starts
    // saying it again by itself if one ever is not.
    const readOnlyKinds = Object.values(calKinds).filter((m) => !m.writable).map((m) => m.label);
    const tz = draft.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

    body().innerHTML = `
      <p>
        ${addable.map(([kind, meta]) =>
          `<button type="button" class="link-btn cal-src-add" data-kind="${escAttr(kind)}">+ ${esc(meta.label)}</button>`).join('')}
      </p>
      ${!readOnlyKinds.length ? '' : `<p class="set-hint" style="grid-column:auto">${esc(readOnlyKinds.join(', '))} ${esc(I18n.t('calendars are read-only — Hmelj shows them, and changes made in the app you normally use appear here on the next sync. Every other kind can be edited from the calendar itself.'))}</p>`}

      <div class="card" style="margin-bottom:14px">
        ${field(I18n.t('Time zone'), `<input id="cal-tz" list="cal-tz-list" value="${escAttr(draft.timezone || '')}" placeholder="${escAttr(tz)}">
          <datalist id="cal-tz-list">${(Intl.supportedValuesOf ? Intl.supportedValuesOf('timeZone') : [])
            .map((z) => `<option value="${escAttr(z)}">`).join('')}</datalist>`,
          I18n.t('Decides which day an event belongs to, and how an event written without a time zone is read. Leave it empty to follow this device. An event that carries its own time zone is always shown at the moment that zone names.'))}
      </div>

      <div class="card" id="dav-card" style="margin-bottom:14px"></div>

      ${!calSources.length ? `<p class="set-hint" style="grid-column:auto">${esc(I18n.t('No calendars set up yet.'))}</p>` : `
      <div class="card-list">${calSources.map((src) => {
        const mine = calList.filter((c) => c.sourceId === src.id);
        const err = src.lastError || mine.map((c) => c.lastError).find(Boolean);
        return `<div class="card" data-src="${escAttr(src.id)}">
          <div class="row" style="gap:8px;align-items:baseline">
            <strong>${esc(src.label)}</strong>
            <span class="set-hint" style="margin:0">${esc(calKinds[src.kind]?.label || src.kind)}</span>
            <span class="spacer"></span>
            ${calKinds[src.kind]?.canCreate ? `<button type="button" class="link-btn cal-src-new" data-src="${escAttr(src.id)}">${esc(I18n.t('New calendar'))}</button>` : ''}
            <button type="button" class="link-btn cal-src-sync" data-src="${escAttr(src.id)}" ${calSyncing.has(src.id) ? 'disabled' : ''}>${esc(calSyncing.has(src.id) ? I18n.t('Syncing…') : I18n.t('Sync now'))}</button>
            <button type="button" class="link-btn cal-src-edit" data-src="${escAttr(src.id)}">${esc(I18n.t('Edit'))}</button>
            <button type="button" class="link-btn danger cal-src-del" data-src="${escAttr(src.id)}">✕</button>
          </div>
          <div class="row" style="margin-top:4px">${err
            ? `<span class="set-hint" style="margin:0;color:var(--danger)">${esc(err)}</span>`
            : `<span class="set-hint" style="margin:0">${mine.filter((c) => c.enabled).length} ${esc(I18n.t('of'))} ${mine.length} ${esc(I18n.t('synced'))}${
                src.lastSyncAt ? ` · ${esc(I18n.t('last synced'))}: ${esc(fmtDate(src.lastSyncAt, { long: true }))}` : ''}</span>`}</div>
          ${calWindowed(src.kind) && calWindow ? `<div class="set-hint" style="margin-top:2px">${
            esc(I18n.t('This provider expands repeating events itself, so its calendars are known from'))} ${esc(fmtDate(calWindow.from, { long: true }))} ${esc(I18n.t('to'))} ${esc(fmtDate(calWindow.to, { long: true }))}.</div>` : ''}
          ${mine.length ? `<div style="margin-top:6px">${mine.map((c) => `
            <div class="cal-row">
              <label class="mini-toggle" style="gap:6px">
                <input type="checkbox" class="cal-pick" data-src="${escAttr(src.id)}" data-cal="${escAttr(c.id)}" ${c.enabled ? 'checked' : ''}>
                <input type="color" class="cal-color-pick" data-cal="${escAttr(c.id)}" value="${escAttr(/^#[0-9a-f]{6}$/i.test(c.color || '') ? c.color : '#0b57d0')}"
                  title="${escAttr(I18n.t(c.colorLocked ? 'Your own colour — double-click to go back to the one the server gives' : 'Pick a colour for this calendar'))}">
                <span>${esc(c.displayName)}</span>
                ${c.readOnly ? `<span class="set-hint" style="margin:0">${esc(I18n.t('read-only'))}</span>` : ''}
                ${c.count ? `<span class="set-hint" style="margin:0" title="${escAttr(I18n.t('Events in this calendar'))}">${c.count}</span>` : ''}
              </label>
              ${c.enabled ? `<div class="cal-row-opts">
                <label class="mini-toggle" style="gap:6px">
                  <span>${esc(I18n.t('Remind me'))}</span>
                  ${sel(`cal-rem-${c.id}`, reminderOptions(), reminderValue(c))}
                </label>
                <label class="mini-toggle" style="gap:6px">
                  <input type="checkbox" class="cal-quiet" data-cal="${escAttr(c.id)}" ${c.followQuietHours ? 'checked' : ''}>
                  <span>${esc(I18n.t('Stay quiet when mail notifications are'))}</span>
                </label>
              </div>` : ''}
            </div>`).join('')}</div>` : ''}
        </div>`;
      }).join('')}</div>`}`;

    document.getElementById('cal-tz').addEventListener('change', (e) => { draft.timezone = e.target.value.trim(); });
    renderDavPublished();
    if (davInfo === null) loadDavPublished().then(renderDavPublished);
    body().querySelectorAll('.cal-src-add').forEach((b) => b.addEventListener('click', () => editCalendarSource(null, b.dataset.kind)));
    body().querySelectorAll('.cal-src-edit').forEach((b) => b.addEventListener('click', () =>
      editCalendarSource(calSources.find((x) => x.id === b.dataset.src))));
    body().querySelectorAll('.cal-src-del').forEach((b) => b.addEventListener('click', () => removeCalendarSource(b.dataset.src)));
    body().querySelectorAll('.cal-src-sync').forEach((b) => b.addEventListener('click', () => syncCalendarSourceNow(b.dataset.src)));
    body().querySelectorAll('.cal-pick').forEach((b) => b.addEventListener('change', () =>
      toggleCalendarSynced(b.dataset.src, b.dataset.cal, b.checked)));
    for (const c of calList) {
      document.getElementById(`cal-rem-${c.id}`)?.addEventListener('change', (e) =>
        patchCalendar(c, { defaultReminder: e.target.value === '' ? null : Number(e.target.value) }));
    }
    body().querySelectorAll('.cal-quiet').forEach((b) => b.addEventListener('change', () => {
      const c = calList.find((x) => x.id === b.dataset.cal);
      if (c) patchCalendar(c, { followQuietHours: b.checked });
    }));
    body().querySelectorAll('.cal-src-new').forEach((b) => b.addEventListener('click', () => newCalendarIn(b.dataset.src)));
    body().querySelectorAll('.cal-color-pick').forEach((b) => {
      // `change`, not `input`: a native colour well fires input continuously
      // while the picker is open, which would be one PATCH per pixel dragged.
      b.addEventListener('change', () => setCalendarColor(b.dataset.cal, b.value));
      // Double-click hands the colour back to the server's own — the way out of
      // a choice, without a second control taking up room on every row.
      b.addEventListener('dblclick', (e) => { e.preventDefault(); setCalendarColor(b.dataset.cal, ''); });
    });
  }

  /**
   * Creates a calendar on the source's own server.
   *
   * The name is all that is asked for. A colour could be picked here too, but
   * the row it lands in has a colour well of its own two seconds later, and one
   * fewer field in the way of making a calendar is worth more than saving that
   * click.
   */
  async function newCalendarIn(sourceId) {
    const src = calSources.find((x) => x.id === sourceId);
    if (!src) return;
    const name = await Dialog.prompt(I18n.t('New calendar'), {
      label: I18n.t('Name for the new calendar'),
      hint: I18n.t('Created on the calendar server itself, so it appears in that provider\'s own apps too.'),
    });
    if (!name) return; // Dialog.prompt already trims and answers null for empty
    try {
      // Slow enough to need saying: it is a round trip to Google or Microsoft,
      // and then a full sync of the source behind it.
      toast(I18n.t('Creating…'));
      await API.createCalendar(sourceId, name);
      await loadCalendars();
      renderCalendars();
      // The sidebar's calendar list is drawn from its own copy.
      Calendar.refresh?.();
      toast(I18n.t('Calendar created'));
    } catch (e) { toast(e.message, 8000); }
  }

  /** A colour of the user's own for one calendar, or '' to follow the server's
   *  again. Its own route rather than patchCalendar's whole-source PUT — see
   *  the PATCH handler in server/index.js. */
  async function setCalendarColor(calendarId, color) {
    try {
      const r = await API.setCalendarColor(calendarId, color);
      if (r?.calendars) calList = r.calendars;
      renderCalendars();
      Calendar.refresh?.();
    } catch (e) { toast(e.message, 6000); }
  }

  /** The reminder picker's options. Outlook's own list (see
   *  calendarStore.js#REMINDER_MINUTES), plus the two entries that are not
   *  offsets: follow the event's own alarm, and never. */
  function reminderOptions() {
    const label = (m) => {
      if (m === 0) return I18n.t('At the time of the event');
      if (m < 60) return `${m} ${I18n.t('minutes before')}`;
      if (m < 1440) { const h = m / 60; return `${h} ${I18n.t(h === 1 ? 'hour before' : 'hours before')}`; }
      if (m < 10080) { const d = m / 1440; return `${d} ${I18n.t(d === 1 ? 'day before' : 'days before')}`; }
      return I18n.t('1 week before');
    };
    return [
      // '' rather than null: a <select> value is always a string, and the
      // handler maps the empty one back to null.
      ['', I18n.t('Whatever the event asks for')],
      ['-1', I18n.t('Never')],
      ...[0, 5, 10, 15, 30, 60, 120, 720, 1440, 2880, 10080].map((m) => [String(m), label(m)]),
    ];
  }

  const reminderValue = (c) => (c.defaultReminder === null || c.defaultReminder === undefined ? '' : String(c.defaultReminder));

  /** Writes one calendar's own settings back. Goes through the source record,
   *  since that is where calendars live — but sends only THIS calendar's
   *  changed fields, so nothing else in the list can be clobbered by a stale
   *  copy of it. */
  async function patchCalendar(cal, patch) {
    const src = calSources.find((x) => x.id === cal.sourceId);
    if (!src) return;
    Object.assign(cal, patch);
    try {
      await API.saveCalendarSource({
        ...src,
        calendars: calList.filter((c) => c.sourceId === src.id).map((c) => ({ ...c })),
      }, src.id);
      await loadCalendars();
      renderCalendars();
    } catch (e) { toast(e.message, 6000); }
  }

  /**
   * Makes sure a mail account's sign-in actually covers what is about to be
   * asked of it, running one more consent round if it does not.
   *
   * Reading a Google or Microsoft calendar needs permission the MAIL sign-in
   * never asked for. Those scopes are deliberately not requested up front (see
   * server/oauth.js#FEATURE_SCOPES): widening them for everybody would mark
   * every existing Google and Microsoft account as needing re-authentication,
   * including accounts that will never open a calendar.
   *
   * So the ask happens here, at the moment it is needed, for the one account it
   * is needed for. An account that already has the permission is not disturbed.
   */
  // Whole sentences, one per feature, rather than a sentence built around a
  // translated noun: "read your " + t('calendars') needs the accusative in
  // Slovenian and the nominative in the dictionary, and one of the two is
  // always wrong. Dialog.confirm escapes its own message, so these are plain
  // text and not markup.
  const FEATURE_ASK = {
    calendar: 'Hmelj needs one more permission to read the calendars on this account.',
    contacts: 'Hmelj needs one more permission to read the contacts on this account.',
  };

  async function ensureOAuthFeature(account, feature) {
    const block = account?.oauth || account?.graph;
    if (!block?.provider) return true;                 // not an OAuth account — nothing to widen
    if ((block.features || []).includes(feature)) return true;

    const provider = block.provider;
    const who = account.email || account.label || '';
    const okToAsk = await Dialog.confirm(
      `${I18n.t(FEATURE_ASK[feature] || FEATURE_ASK.calendar)} `
      + `${I18n.t('You will be asked to sign in once more as')} ${who}. `
      + I18n.t('Nothing else about this account changes, and your other accounts are untouched.'),
      { title: I18n.t('One more sign-in'), okLabel: I18n.t('Sign in') });
    if (!okToAsk) return false;

    try {
      const { state } = await OAuthFlow.signIn({
        provider,
        email: account.email,
        accountId: account.id,
        // The union of what it already has and what is being asked for — the
        // server refuses anything not on its own list, so this cannot widen
        // the grant beyond the two known features.
        features: [...new Set([...(block.features || []), feature])],
        onStatus: (kind, detail) => {
          if (kind === 'manual') toast(I18n.t('Open the sign-in page in your browser to continue'), 8000);
          else if (kind === 'waiting') toast(I18n.t('Waiting for the sign-in to finish…'), 4000);
        },
      });
      await API.oauthAttach(state, account.id);
      // The account list carries the granted features, and the next check reads
      // them — so refresh it rather than assuming.
      await state_accountsRefresh();
      return true;
    } catch (e) {
      toast(I18n.t('That sign-in did not complete: ') + e.message, 8000);
      return false;
    }
  }

  /** Re-reads the account list into app state, so a freshly widened grant is
   *  visible to the next check without a page reload. */
  async function state_accountsRefresh() {
    try { state.accounts = await API.accounts(); } catch { /* the next load picks it up */ }
  }

  /* ---------- what Hmelj publishes (the CalDAV/CardDAV server) ----------
   *
   * Two shapes, and the difference is the feature: a SINGLE publication is one
   * calendar or address book served as itself, and an AGGREGATE merges several
   * into one collection. Each source inside an aggregate contributes either
   * full detail or busy-only, which is what makes a shared household calendar
   * workable — your partner sees that Thursday afternoon is taken without
   * seeing who you are seeing. */
  async function loadDavPublished() {
    try { davInfo = await API.davPublished(); } catch { davInfo = { published: [], publishable: { calendars: [], addressbooks: [] } }; }
  }

  function renderDavPublished() {
    const host = document.getElementById('dav-card');
    if (!host) return;
    if (davInfo === null) { host.innerHTML = `<div class="set-hint">${esc(I18n.t('Loading…'))}</div>`; return; }
    const pubs = davInfo.published || [];
    host.innerHTML = `
      <div class="row" style="margin-bottom:8px;align-items:baseline">
        <b>${esc(I18n.t('Share from Hmelj'))}</b>
        <span class="spacer"></span>
        <button type="button" class="link-btn" id="dav-add-cal">+ ${esc(I18n.t('Calendar'))}</button>
        <button type="button" class="link-btn" id="dav-add-card">+ ${esc(I18n.t('Contacts'))}</button>
      </div>
      <p class="set-hint" style="grid-column:auto;margin:0 0 8px">${esc(I18n.t('Publish a calendar or address book so a phone or another app can subscribe to it over CalDAV or CardDAV.'))}</p>
      ${!davInfo.hasPassword ? `<p class="set-hint" style="grid-column:auto;color:var(--danger)">${
        esc(I18n.t('You will also need an app password — create one under Settings › Login. Your Hmelj password is not accepted for this.'))}</p>` : ''}
      ${pubs.length ? `<div class="set-hint" style="margin:0 0 8px">
        ${esc(I18n.t('Server address'))}: <code>${esc(davInfo.baseUrl)}</code> · ${esc(I18n.t('Username'))}: <code>${esc(state.username)}</code>
      </div>` : ''}
      ${!pubs.length ? `<p class="set-hint" style="grid-column:auto">${esc(I18n.t('Nothing published yet.'))}</p>` : `
      <div class="card-list">${pubs.map((p) => `
        <div class="card"><div class="row" style="gap:8px;align-items:baseline">
          <strong>${esc(p.label)}</strong>
          <span class="set-hint" style="margin:0">${esc(I18n.t(p.kind === 'calendar' ? 'Calendar' : 'Contacts'))}</span>
          ${p.mode === 'aggregate' ? `<span class="set-hint" style="margin:0">${esc(I18n.t('merged'))} · ${p.sources.length}</span>` : ''}
          <span class="set-hint" style="margin:0">${esc(p.writable ? I18n.t('read and write') : I18n.t('read-only'))}</span>
          <span class="spacer"></span>
          <button type="button" class="link-btn dav-edit" data-id="${escAttr(p.id)}">${esc(I18n.t('Edit'))}</button>
          <button type="button" class="link-btn danger dav-del" data-id="${escAttr(p.id)}">✕</button>
        </div>
        ${p.sources.some((sx) => sx.detail === 'busy') ? `<div class="set-hint" style="margin-top:2px">${
          esc(I18n.t('Some sources show only that the time is taken, with no details.'))}</div>` : ''}
        </div>`).join('')}</div>`}`;

    document.getElementById('dav-add-cal').addEventListener('click', () => editDavPublished(null, 'calendar'));
    document.getElementById('dav-add-card').addEventListener('click', () => editDavPublished(null, 'addressbook'));
    host.querySelectorAll('.dav-edit').forEach((b) => b.addEventListener('click', () =>
      editDavPublished(pubs.find((p) => p.id === b.dataset.id))));
    host.querySelectorAll('.dav-del').forEach((b) => b.addEventListener('click', () => removeDavPublished(b.dataset.id)));
  }

  async function editDavPublished(existing, kind = null) {
    const k = existing?.kind || kind || 'calendar';
    const choices = k === 'calendar' ? davInfo.publishable.calendars : davInfo.publishable.addressbooks;
    if (!choices.length) {
      toast(I18n.t('Nothing to publish yet — set up a calendar or an address book first.'), 6000);
      return;
    }
    const idOf = (c) => c.id;
    const chosen = new Map((existing?.sources || []).map((sx) => [sx.calendarId || sx.bookId || sx.sourceId, sx.detail]));

    const vals = await Dialog.form(existing ? I18n.t('Edit what is shared') : I18n.t('Share from Hmelj'), `
      ${field(I18n.t('Name'), `<input id="dp-label" value="${escAttr(existing?.label || '')}" placeholder="${escAttr(k === 'calendar' ? I18n.t('Calendar') : I18n.t('Contacts'))}">`,
        I18n.t('What subscribers will see it called.'))}
      <p class="set-hint" style="grid-column:auto">${esc(I18n.t('Tick more than one to merge them into a single shared collection.'))}</p>
      ${choices.map((c, i) => `
        <div class="row" style="gap:8px;align-items:baseline">
          <label class="mini-toggle" style="gap:6px;flex:1">
            <input type="checkbox" class="dp-src" data-i="${i}" ${chosen.has(idOf(c)) ? 'checked' : ''}>
            <span>${esc(c.label)}</span>
            <span class="set-hint" style="margin:0">${esc(c.source)}</span>
          </label>
          ${k === 'calendar' ? `<select class="dp-detail" data-i="${i}">
            <option value="full" ${chosen.get(idOf(c)) !== 'busy' ? 'selected' : ''}>${esc(I18n.t('Full details'))}</option>
            <option value="busy" ${chosen.get(idOf(c)) === 'busy' ? 'selected' : ''}>${esc(I18n.t('Busy only'))}</option>
          </select>` : ''}
        </div>`).join('')}
      <p class="set-hint" style="grid-column:auto">${esc(I18n.t('“Busy only” shows that the time is taken — no title, no place, no attendees. A merged collection is always read-only.'))}</p>`,
      {
        okLabel: I18n.t('Save'),
        wide: true,
        getValue: () => ({
          label: document.getElementById('dp-label').value.trim(),
          kind: k,
          sources: [...document.querySelectorAll('.dp-src')].map((b, n) => {
            if (!b.checked) return null;
            const c = choices[Number(b.dataset.i)];
            const detail = document.querySelector(`.dp-detail[data-i="${b.dataset.i}"]`)?.value || 'full';
            return k === 'calendar'
              ? { calendarId: c.id, detail }
              : { bookId: c.id === 'local-contacts' ? '' : c.id, sourceId: c.id === 'local-contacts' ? 'local-contacts' : (c.sourceId || ''), detail: 'full' };
          }).filter(Boolean),
        }),
      });
    if (!vals || vals === 'cancel') return;
    if (!vals.sources.length) { toast(I18n.t('Choose at least one to share')); return; }
    try {
      await API.saveDavPublished(vals, existing?.id);
      await loadDavPublished();
      renderCalendars();
    } catch (e) { toast(e.message, 8000); }
  }

  async function removeDavPublished(id) {
    const p = (davInfo.published || []).find((x) => x.id === id);
    if (!await Dialog.confirm(
      `${I18n.t('Stop sharing')} “${p?.label || ''}”? ${I18n.t('Subscribed devices stop seeing it. Nothing is deleted.')}`,
      { title: I18n.t('Stop sharing'), okLabel: I18n.t('Stop sharing'), danger: true })) return;
    try {
      await API.deleteDavPublished(id);
      await loadDavPublished();
      renderCalendars();
    } catch (e) { toast(e.message, 6000); }
  }

  async function editCalendarSource(existing, kind = null) {
    const k = existing?.kind || kind || 'caldav';
    const meta = calKinds[k] || {};
    const accounts = calAccountsFor(k);
    if (meta.credentials === 'account' && !accounts.length) {
      toast(I18n.t('No mail account of that type to sign in with'), 5000);
      return;
    }
    const bodyHtml = `
      ${field(I18n.t('Name'), `<input id="cs-label" value="${escAttr(existing?.label || meta.label || '')}">`)}
      ${k === 'local' ? `<p class="set-hint" style="grid-column:auto">${esc(I18n.t('A calendar kept in Hmelj itself. Nothing is synced anywhere — its events live with your settings, and are included in your backups.'))}</p>` : ''}
      ${k === 'caldav' ? `
        ${field(I18n.t('Server address'), `<input id="cs-url" placeholder="https://cloud.example.com" value="${escAttr(existing?.url || '')}">`,
          I18n.t('The server, or the calendar itself if you already have its URL. Hmelj works the rest out.'))}
        ${field(I18n.t('Username'), `<input id="cs-user" autocomplete="off" value="${escAttr(existing?.username || '')}">`)}
        ${field(I18n.t('Password'), `<input id="cs-pass" type="password" autocomplete="new-password" placeholder="${escAttr(existing?.passwordSet ? I18n.t('unchanged') : '')}">`,
          I18n.t('If your provider uses two-factor authentication, this has to be an app-specific password generated in their own settings — the account password will always be refused.'))}
      ` : field(I18n.t('Sign in with'), sel('cs-account', accounts.map((a) => [a.id, a.label]), existing?.accountId || accounts[0]?.id))}`;

    const vals = await Dialog.form(existing ? I18n.t('Edit calendar source') : I18n.t('Add calendar source'), bodyHtml, {
      okLabel: I18n.t('Continue'),
      getValue: () => ({
        label: document.getElementById('cs-label').value.trim(),
        url: document.getElementById('cs-url')?.value.trim() || '',
        username: document.getElementById('cs-user')?.value.trim() || '',
        password: document.getElementById('cs-pass')?.value || '',
        accountId: document.getElementById('cs-account')?.value || '',
      }),
    });
    if (!vals || vals === 'cancel') return;

    const draftSrc = { ...vals, kind: k, id: existing?.id };

    // Before discovery, not after: without the calendar permission the probe
    // comes back 401 from Google with nothing useful to say, and the user is
    // left believing their password is wrong.
    if (meta.credentials === 'account') {
      const account = accounts.find((a) => a.id === draftSrc.accountId);
      if (!await ensureOAuthFeature(account, 'calendar')) return;
    }

    // A Hmelj calendar has no server to ask, so there is no discovery step and
    // no list to choose from — saving it creates the calendar.
    if (k === 'local') {
      try {
        await API.saveCalendarSource(draftSrc, existing?.id);
        await loadCalendars();
        renderCalendars();
        Calendar.refresh();
      } catch (e) { toast(I18n.t('Could not save that source: ') + e.message, 8000); }
      return;
    }

    let found;
    try {
      toast(I18n.t('Looking for calendars…'), 2500);
      found = await API.discoverCalendarSource(draftSrc);
    } catch (e) {
      toast(I18n.t('Could not reach that server: ') + e.message, 8000);
      return;
    }
    if (!found.collections?.length) {
      toast(I18n.t('That server answered, but has no calendars this account can see.'), 8000);
      return;
    }

    // Chosen against what the server actually reported, and never all of them
    // by default: a work server routinely shares a dozen calendars nobody wants,
    // and each one is a sync of its own.
    const previous = new Map((existing ? calList.filter((c) => c.sourceId === existing.id) : []).map((c) => [c.displayName, c]));
    const pick = await Dialog.form(I18n.t('Calendars'),
      `<div class="pick-list">${found.collections.map((c, i) => `<label class="pick-row">
        <input type="checkbox" class="cs-cal" data-i="${i}" ${previous.get(c.displayName)?.enabled || (!existing && found.collections.length === 1) ? 'checked' : ''}>
        <span class="pick-name">${esc(c.displayName)}</span>
        ${c.readOnly ? `<span class="pick-tag">${esc(I18n.t('read-only'))}</span>` : ''}
      </label>`).join('')}</div>`,
      { okLabel: I18n.t('Save'), getValue: () => [...document.querySelectorAll('.cs-cal')].map((b) => b.checked) });
    if (!pick || pick === 'cancel') return;

    try {
      const saved = await API.saveCalendarSource({
        ...draftSrc,
        principalUrl: found.principalUrl, homeUrl: found.homeUrl,
        calendars: found.collections.map((c, i) => ({ ...c, enabled: !!pick[i] })),
      }, existing?.id);
      await loadCalendars();
      renderCalendars();
      await syncCalendarSourceNow(saved.id);
    } catch (e) {
      toast(I18n.t('Could not save that source: ') + e.message, 8000);
    }
  }

  async function removeCalendarSource(id) {
    const src = calSources.find((x) => x.id === id);
    if (!await Dialog.confirm(
      `${I18n.t('Stop syncing')} ${src?.label || ''}? ${I18n.t('Its events are removed from Hmelj. Nothing is deleted on the server.')}`,
      { title: I18n.t('Stop syncing'), okLabel: I18n.t('Stop syncing'), danger: true })) return;
    try {
      await API.deleteCalendarSource(id);
      await loadCalendars();
      renderCalendars();
      Calendar.refresh();
    } catch (e) { toast(e.message, 6000); }
  }

  async function toggleCalendarSynced(sourceId, calendarId, enabled) {
    const src = calSources.find((x) => x.id === sourceId);
    if (!src) return;
    try {
      await API.saveCalendarSource({
        ...src,
        calendars: calList.filter((c) => c.sourceId === sourceId)
          .map((c) => ({ ...c, enabled: c.id === calendarId ? enabled : c.enabled })),
      }, sourceId);
      await loadCalendars();
      renderCalendars();
      if (enabled) await syncCalendarSourceNow(sourceId);
      else Calendar.refresh();
    } catch (e) { toast(e.message, 6000); }
  }

  async function syncCalendarSourceNow(id) {
    if (!id || calSyncing.has(id)) return;
    calSyncing.add(id);
    renderCalendars();
    try {
      const r = await API.syncCalendarSource(id);
      const failed = (r.calendars || []).find((c) => c.error);
      if (failed) toast(`${I18n.t('Sync failed')}: ${failed.error}`, 8000);
      else {
        const n = (r.calendars || []).reduce((a, c) => a + (c.added || 0), 0);
        toast(n ? `${I18n.t('Synced')}: ${n} ${I18n.t('events')}` : I18n.t('Already up to date'));
      }
      calSources = r.sources || calSources;
      calList = r.calendars || calList;
      Calendar.refresh();
    } catch (e) {
      toast(`${I18n.t('Sync failed')}: ${e.message}`, 8000);
    } finally {
      calSyncing.delete(id);
      renderCalendars();
    }
  }

  function renderTab() {
    ({ general: renderGeneral, reading: renderReading, compose: renderCompose, identities: renderIdentities, filters: renderFilters, subject: renderSubject, saved: renderSaved, templates: renderTemplates, folders: renderFolders, scheduler: renderScheduler, offline: renderOffline, contacts: renderContacts, calendars: renderCalendars, accounts: renderAccountsTab, security: renderSecurity, admin: renderAdmin, log: renderLog }[tab])();
  }

  /** `startTab` is for the callers that mean a specific one (the user menu's
   * Mail accounts / Manage folders / Contacts shortcuts). Plain "Settings"
   * passes nothing and reopens wherever the dialog was last left — including
   * where one of those shortcuts left it, which is the point: get sent to
   * Folders once, and the next plain open is still Folders. */
  async function open(startTab) {
    draft = { ...state.settings };
    identities = structuredClone(state.identities);
    filters = await API.filters();
    subjectRules = await API.subjectRules();
    savedSearches = structuredClone(state.savedSearches || []);
    contactGroups = structuredClone(state.contactGroups || []);
    templates = await API.templates().catch(() => []);
    savedSubjectKey = subjectKey(subjectRules);
    // Every rule closed and no filter on each open, the same reasoning the
    // Filters tab reopens on its list for: a search left over from last time
    // looks exactly like rules having gone missing.
    subjectExpanded.clear();
    subjectSearch = '';
    // The test box starts empty on each open — a subject pasted last time is
    // not something to reopen into, and the account picker re-derives itself.
    subjectTest = { subject: '', accountId: null, result: null, steps: [], timer: null };
    // Filters tab always reopens on the list, never inside an editor whose
    // filter may not even exist any more.
    filtersView = 'list';
    editingFilterId = null;
    editorPristine = null;
    editorIsNew = false;
    leavingEditor = false;
    filtersListScrollTop = 0;
    savedFiltersKey = filtersKey(filters);
    filterFoldersLoaded = false;
    // Re-read rather than cached for the module's lifetime like oauthProviders:
    // these numbers climb while the backfill runs, so a figure from the last
    // time Settings was open would understate a fresh index every time.
    searchIndexInfo = null;
    contacts = structuredClone(state.contacts);
    // Cheap refresh, not just at boot — picks up a custom font an admin
    // uploaded from another session without needing a full reload here too.
    await refreshCustomFonts();
    // A wizard abandoned by closing the dialog is not somewhere to reopen into
    // — its draft is long gone. The Accounts tab always comes back as the list.
    accountsView = 'list';
    // Refetched per open rather than per page load: mail arrives, and so do new
    // people to suggest. Within one open it's cached (the Contacts tab
    // re-renders on every add/delete, and each rescan is a full cache scan).
    contactSuggestions = null;
    // Same reasoning, and it can be changed from outside Settings entirely (the
    // warning banner's own button), so a cached copy would go stale unnoticed.
    trustedSenders = null;
    // Contacts tab view state starts clean on every open — a search left over
    // from last time would look like contacts having gone missing.
    ctSearch = '';
    ctSelected = new Set();
    ctSuggestOpen = false;
    // Refetched per open, for the same reason as the suggestions above: the
    // background poller changes these under us (a book's contact count, a
    // last-synced time, a credential that has since started failing), and a
    // panel showing what was true when the page loaded is worse than one that
    // takes a moment to fill in.
    ctSources = null;
    ctSyncing = new Set();
    calSources = null;
    calSyncing = new Set();
    apList = null;
    davInfo = null;
    tab = startTab || lastTab();
    rememberTab();
    let activeBtn;
    document.querySelectorAll('#settings-tabs button').forEach((b) => {
      const active = b.dataset.tab === tab;
      b.classList.toggle('active', active);
      if (active) activeBtn = b;
    });
    document.getElementById('settings-modal').hidden = false;
    renderTab();
    // Same reasoning as switchTab()'s own scrollIntoView (mobile's tab strip
    // scrolls horizontally) — opening straight to a specific tab (the
    // user-menu's Accounts/Folders/Contacts/Run-filters shortcuts) must
    // reveal it too, not just the click-driven path through switchTab().
    activeBtn?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  // Both the desktop footer's button and the mobile save bar's (see
  // index.html/app.css — mobile pins Save above the tab strip instead of in
  // a footer that used to sit below whatever settings content there was)
  // trigger this same save — one status message written to both status
  // spans, harmless when one of them is hidden by CSS.
  async function saveSettings() {
    collectCurrentTab();
    const langChanged = draft.language !== state.settings.language;
    const statuses = [document.getElementById('settings-status'), document.getElementById('settings-status-mobile')];
    for (const s of statuses) s.textContent = 'Saving…';
    // The App font keys are per-device (localStorage), not synced to the
    // server — see DEVICE_SETTINGS_KEYS in app.js. Persist whatever this form
    // just set for them locally, strip every device key from the server
    // payload, then let saveServerSettings re-apply the (now up-to-date)
    // local values back onto its response.
    // THEME_DEVICE_KEYS are skipped here deliberately: this dialog has no
    // control for them at all any more, so `draft` only carries the stale copy
    // it snapshotted at open() — writing that back would undo a theme picked
    // in the meantime. The picker already saved them itself.
    const devicePatch = {};
    for (const k of DEVICE_SETTINGS_KEYS) if (!THEME_DEVICE_KEYS.includes(k)) devicePatch[k] = draft[k];
    saveDeviceSettings(devicePatch);
    const serverDraft = { ...draft };
    for (const k of DEVICE_SETTINGS_KEYS) delete serverDraft[k];
    state.settings = await saveServerSettings(serverDraft);
    state.identities = await API.saveIdentities(identities);
    await API.saveFilters(filters);
    savedFiltersKey = filtersKey(filters);
    // Same treatment as filters: the footer Save saves every tab, not just the
    // one on screen. A rejected rule set must not take the rest of Save down
    // with it — the tab's own button reports the reason properly.
    try {
      await API.saveSubjectRules(subjectRules);
      savedSubjectKey = subjectKey(subjectRules);
    } catch (e) {
      toast(I18n.t('Could not save the subject rules') + ': ' + e.message, 5000);
    }
    // Same again: adopt the server's normalised list (it drops empty queries and
    // fills in missing names), then rebuild the sidebar so a rename or reorder
    // shows without a reload.
    try {
      state.savedSearches = await API.saveSavedSearches(savedSearches);
      savedSearches = structuredClone(state.savedSearches);
      // No loadFolders() here — saveSettings already rebuilds the sidebar
      // below, which is what makes a rename or reorder show without a reload.
    } catch (e) {
      toast(I18n.t('Could not save the saved searches') + ': ' + e.message, 5000);
    }
    try {
      // Compose is told directly, so the 📋 button appears or disappears
      // without a reload the moment the first template exists.
      Compose.setTemplates(templates = await API.saveTemplates(templates));
    } catch (e) {
      toast(I18n.t('Could not save the templates') + ': ' + e.message, 5000);
    }
    // Only the LOCAL address book. Synced contacts belong to somebody else's
    // server and are written there through their own route as they are edited —
    // sending them here would be asking contacts.json to store a mirror it must
    // never hold (see server/contactSources.js's header).
    state.contacts = await API.saveContacts(contacts.filter((c) => !c.synced));
    // After the contacts, and adopting the server's answer for the same reason
    // saved searches do: it drops junk members and disambiguates duplicate
    // names, and the `👥 Name` token the composer writes resolves BY NAME — so
    // the client and the server must agree on what each group is called.
    // Published to `state` as well as the draft, or an open composer would not
    // offer a group until the next full page load (same reasoning as
    // adoptImportedContacts).
    try {
      state.contactGroups = await API.saveContactGroups(contactGroups);
      contactGroups = structuredClone(state.contactGroups);
    } catch (e) {
      toast(I18n.t('Could not save the contact groups') + ': ' + e.message, 5000);
    }
    Compose.setIdentities(state.identities);
    // Picks up the spell-check toggle without a reload — an open composer
    // either starts underlining or hands itself back to the browser right away.
    Proofread.refresh();
    applyTheme();
    applyUiFont();
    applyKeepScreenOn();
    applyReadingPane();
    loadFolders();
    loadMessages();
    // A message already open keeps its own parked frame options, so the new
    // font has to be pushed into it explicitly — otherwise the one message the
    // user was looking at while changing the setting is the one that does not
    // change (see app.js#refreshOpenMessageFonts).
    refreshOpenMessageFonts();
    for (const s of statuses) s.textContent = 'Saved ✓';
    setTimeout(() => {
      for (const s of statuses) s.textContent = '';
      document.getElementById('settings-modal').hidden = true;
      if (langChanged) location.reload();
    }, 600);
  }

  /** Closes without saving — the X button's behaviour, also used by the
   * hardware back key (see app.js's navCollapseOneLevel). Anything typed but
   * not saved is simply dropped, exactly as before; the applyUiFont() call
   * matters because the App font pickers preview live while the dialog is
   * open, so leaving without saving has to put the last-saved font back. */
  function close() {
    document.getElementById('settings-modal').hidden = true;
    applyUiFont();
  }

  function isOpen() {
    return !document.getElementById('settings-modal').hidden;
  }

  /** One "back" press inside an open Settings, for app.js's
   * navCollapseOneLevel: the Filters tab's editor collapses to its own list
   * first, so the hardware/browser back key does what the ← button does
   * instead of closing the whole dialog from two levels deep. False when
   * there's no inner level to leave, and the caller closes Settings itself. */
  function collapseOneLevel() {
    if (tab === 'filters' && filtersView === 'edit') {
      // Async (it may put a save/discard prompt up first), but the caller
      // needs its answer now — "yes, this press was handled in here".
      leaveFilterEditor();
      return true;
    }
    return false;
  }

  function init() {
    document.querySelectorAll('#settings-tabs button').forEach((b) =>
      b.addEventListener('click', () => switchTab(b.dataset.tab)));
    // Delegated from the modal, bound once: every tab rebuilds its own body on
    // each render, so a listener per badge would be re-attached constantly and
    // leak one per render of every tab ever opened.
    document.getElementById('settings-modal').addEventListener('click', (e) => {
      const b = e.target.closest('.set-help');
      if (!b) return;
      // A `?` inside a <label> would otherwise activate the control the label
      // is for — clicking it would toggle the very tick box it explains.
      e.preventDefault();
      e.stopPropagation();
      Dialog.alert(b.dataset.help, { title: b.dataset.helpTitle || I18n.t('What this setting does') });
    });
    document.getElementById('btn-settings-close').addEventListener('click', close);
    document.getElementById('btn-settings-save').addEventListener('click', saveSettings);
    document.getElementById('btn-settings-save-mobile').addEventListener('click', saveSettings);
  }

  function setAdmin(isAdmin) {
    const btn = document.getElementById('tab-admin');
    if (btn) btn.hidden = !isAdmin;
  }

  return { init, open, close, isOpen, collapseOneLevel, accountWizard, setAdmin };
})();
