// Hmelj — settings modal
const Settings = (() => {
  let tab = 'general';
  let draft = {}; // settings being edited
  let identities = [];
  let filters = [];
  let contacts = [];
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

  function field(label, inputHtml, hint = '') {
    return `<label>${label}</label><div>${inputHtml}</div>` + (hint ? `<div></div><div class="set-hint">${hint}</div>` : '');
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
    </div>`;
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
      ${field('Compact unsubscribe banner', chk('s-unsub-min', draft.unsubscribeBannerCompact), 'Show that banner folded to just the icon and the button. Click the icon on a message to see where the request would go — the confirmation dialog names it either way.')}
      ${field('Message font', fontSel('s-font', draft.messageFont))}
      ${field('Message font size', num('s-fontsize', draft.messageFontSize, 11, 24))}
    </div>`;
  }

  function renderCompose() {
    body().innerHTML = `<div class="set-grid">
      ${field('Default format', sel('s-format', [['html', 'HTML (rich text)'], ['plain', 'Plain text']], draft.composeFormat))}
      ${field('Default font', composeFontSel('s-compose-font', draft.composeFont), 'Used for what you write in new messages, replies and forwards — not for the quoted original. Rich text only. The toolbar\'s font button still overrides it per message.')}
      ${field('Quoted message on reply', sel('s-quote', [['below', 'Below my reply'], ['above', 'Above my reply'], ['none', 'Do not quote']], draft.replyQuotePosition))}
      ${field('Autosave drafts every (seconds)', num('s-autosave', draft.autosaveDraftSeconds, 0, 600), '0 disables autosave.')}
      ${field('Request read receipts by default', chk('s-receipt', draft.requestReadReceipt))}
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
    return `<span class="conn ok">●</span><span class="set-hint" style="margin:0">${I18n.t('Connected')} · ${I18n.t('synced')} ${fmtRelativeTime(s.lastSyncedAt)}</span>`;
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
    // A shared-in account (someone else's, shared to us — see the plan doc)
    // never shows credentials/server-setting controls at all: no Edit, no
    // Folders (special-folder mapping + hidden-folders are owner-only in
    // this first pass — a per-viewer override for hidden folders is a
    // planned follow-up), no Disable, and Remove becomes Leave (removes
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
      ${grantees}
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

  function signatureEditor(id, i) {
    const html = sigToEditableHtml(id.signature);
    return `<div class="sig-editor" data-i="${i}">
      <div class="editor-toolbar sig-toolbar">
        <button type="button" data-cmd="bold" title="Bold"><b>B</b></button>
        <button type="button" data-cmd="italic" title="Italic"><i>I</i></button>
        <button type="button" data-cmd="underline" title="Underline"><u>U</u></button>
        <button type="button" data-cmd="insertUnorderedList" title="Bullet list">•≡</button>
        <button type="button" data-cmd="createLink" title="Insert link">🔗</button>
        <button type="button" data-cmd="removeFormat" title="Clear formatting">⌫ᴬ</button>
        <button type="button" class="sig-img" title="Insert image">🖼</button>
        <button type="button" class="sig-source" title="View HTML source">&lt;/&gt;</button>
      </div>
      <div class="sig-rich" id="id-sig-rich-${i}" contenteditable="true">${html}</div>
      <textarea class="sig-src" id="id-sig-src-${i}" hidden>${esc(html)}</textarea>
      <input type="file" class="sig-img-input" accept="image/*" hidden>
      <input type="hidden" id="id-sig-${i}" value="${escAttr(html)}">
    </div>`;
  }

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
      <div><label>Signature</label>${signatureEditor(id, i)}</div>` : ''}
    </div>`;
  }

  /** Wires toolbar buttons for every signature editor currently in the DOM —
   * called after renderIdentities() sets body().innerHTML. Reuses the same
   * document.execCommand pattern as the compose editor (see compose.js). */
  function wireSignatureEditors() {
    body().querySelectorAll('.sig-editor').forEach((wrap) => {
      const rich = wrap.querySelector('.sig-rich');
      const src = wrap.querySelector('.sig-src');
      const hidden = wrap.querySelector('input[type="hidden"]');
      const imgInput = wrap.querySelector('.sig-img-input');
      let savedRange = null;

      const syncHidden = () => { hidden.value = rich.hidden ? src.value : rich.innerHTML; };
      rich.addEventListener('input', syncHidden);
      src.addEventListener('input', syncHidden);

      wrap.querySelectorAll('button[data-cmd]').forEach((b) => {
        b.addEventListener('mousedown', (e) => e.preventDefault()); // keep selection in `rich`
        b.addEventListener('click', async () => {
          rich.focus();
          if (b.dataset.cmd === 'createLink') {
            const sel = window.getSelection();
            const range = sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
            const url = await Dialog.prompt(I18n.t('Insert link'), { label: I18n.t('Link URL (https://…):'), placeholder: 'https://' });
            if (url && range) { sel.removeAllRanges(); sel.addRange(range); document.execCommand('createLink', false, url); }
          } else {
            document.execCommand(b.dataset.cmd, false, null);
          }
          syncHidden();
        });
      });

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
      identities.push({ id: uid(), name: '', email: '', organization: '', replyTo: '', signature: '', signatureOn: 'new-reply', signatureDelimiter: true, accountId: allAccounts()[0]?.id, default: identities.length === 0 });
      renderIdentities();
    });
    body().querySelectorAll('.id-add-alias').forEach((b) => b.addEventListener('click', () => {
      collectIdentities();
      identities.push({ id: uid(), name: '', email: '', organization: '', replyTo: '', signature: '', signatureOn: 'new-reply', signatureDelimiter: true, accountId: b.dataset.acct, default: identities.length === 0 });
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
        signature: g('sig')?.value ?? id.signature,
        signatureOn: g('sigon')?.value ?? id.signatureOn,
        signatureDelimiter: g('sigdelim') ? g('sigdelim').checked : (id.signatureDelimiter ?? true),
        accountId: g('acct') ? g('acct').value : id.accountId,
        default: document.getElementById(`id-def-${i}`)?.checked ?? id.default,
      };
    });
    if (identities.length && !identities.some((x) => x.default)) identities[0].default = true;
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
    const folders = filterFolderCache[accountId] || [];
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

    // A shared account's viewer (not its owner — see the plan doc's Phase 2)
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
      </div>` : `<p class="set-hint" style="grid-column:auto">${I18n.t("This account is shared with you — pick which of its folders show in your own sidebar. The owner's settings (special folders, sync) aren't shown here.")}</p>`}
      <div class="card-list">
      ${folderList.map((f) => `<div class="card"><div class="row">
        <span>${esc(f.path)}</span>
        ${f.unseen != null ? `<span class="set-hint" style="margin:0">${f.total} msgs, ${f.unseen} unread</span>` : ''}
        <span class="spacer"></span>
        <label class="mini-toggle" title="${!isOwner && f.hiddenByOwner ? escAttr(I18n.t("Hidden by this account's owner")) : ''}">
          <input type="checkbox" class="fo-show" data-path="${escAttr(f.path)}" ${f.hidden ? '' : 'checked'} ${!isOwner && f.hiddenByOwner ? 'disabled' : ''}> ${I18n.t('Show in sidebar')}
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
          <div class="row" style="flex-wrap:wrap;gap:10px;align-items:flex-end">
            <label>${I18n.t('Month')}<br>${sel('sch-hol-new-month', Array.from({ length: 12 }, (_, i) => [i + 1, i + 1]), 1)}</label>
            <label>${I18n.t('Day')}<br>${num('sch-hol-new-day', 1, 1, 31)}</label>
            <label>${I18n.t('Name')}<br>${txt('sch-hol-new-name', '', I18n.t('e.g. Independence Day'))}</label>
            <label class="mini-toggle" style="margin-bottom:8px">${chk('sch-hol-new-workfree', true)} ${I18n.t('Work-free')}</label>
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
      </div>`;

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

  /* Contacts tab state that has to survive a re-render (every edit, add, delete
   * and import re-renders the whole tab): the search box's text, which contacts
   * are ticked, and whether the suggestions card is expanded. Reset per Settings
   * open, not per render. */
  let ctSearch = '';
  let ctSelected = new Set();
  let ctSuggestOpen = false;

  /** Contacts matching the search box, in list order. Matches name or address,
   * case-insensitively, on any substring — an address book is searched for
   * "@firma.si" at least as often as for a name. */
  function filteredContacts() {
    const q = ctSearch.trim().toLowerCase();
    if (!q) return contacts;
    return contacts.filter((c) => `${c.name} ${c.email}`.toLowerCase().includes(q));
  }

  // A few thousand contacts is a few thousand pairs of <input>s — enough to make
  // the tab visibly slow to open and to type in. Only this many rows are drawn;
  // searching is how you reach the rest, and every action that operates on "all
  // matching" still covers matches that aren't currently drawn.
  const CT_RENDER_CAP = 200;

  function renderContacts() {
    const ewsAccounts = allAccounts().filter((a) => a.type === 'ews' && !a.disabled);
    const graphAccounts = allAccounts().filter((a) => a.type === 'graph' && !a.disabled);
    const matches = filteredContacts();
    const shown = matches.slice(0, CT_RENDER_CAP);
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
      <p class="set-hint" style="grid-column:auto">Google sync tip: export your contacts from contacts.google.com as Google CSV, then import the file here. Live CardDAV sync is on the roadmap.</p>
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
        <label class="mini-toggle" style="gap:6px"><input type="checkbox" id="ct-all" ${shown.length && shown.every((c) => ctSelected.has(c.id)) ? 'checked' : ''}> <span>${I18n.t('Select')}</span></label>
        ${matches.length > shown.length ? `<button type="button" class="link-btn" id="ct-select-matching">${I18n.t('Select all matching')} (${matches.length})</button>` : ''}
        ${selectedCount ? `<span class="set-hint" style="margin:0">${selectedCount} ${I18n.t('selected')}</span>
          <button type="button" class="link-btn" id="ct-clear-sel">${I18n.t('Clear selection')}</button>
          <span class="spacer"></span>
          <button type="button" class="btn-sm danger" id="ct-del-sel">${I18n.t('Delete selected')}</button>` : ''}
      </div>
      <div class="card-list" id="ct-list">
      ${shown.map((c) => `<div class="card" data-id="${escAttr(c.id)}"><div class="row">
        <input type="checkbox" class="ct-pick" data-id="${escAttr(c.id)}" ${ctSelected.has(c.id) ? 'checked' : ''}>
        <input class="ct-name grow" value="${escAttr(c.name)}" placeholder="Name">
        <input class="ct-email grow" value="${escAttr(c.email)}" placeholder="email@example.com">
        <button class="link-btn ct-del" data-id="${escAttr(c.id)}">✕</button>
      </div></div>`).join('')}
      </div>
      ${matches.length > shown.length ? `<p class="set-hint" style="grid-column:auto">${I18n.t('Showing the first')} ${shown.length} ${I18n.t('of')} ${matches.length} — ${I18n.t('search to narrow the list down.')}</p>` : ''}
      ${!matches.length ? `<p class="set-hint" style="grid-column:auto">${contacts.length ? I18n.t('No contacts match your search.') : I18n.t('No contacts yet — add one, or import them above.')}</p>` : ''}`;

    const search = document.getElementById('ct-search');
    search.addEventListener('input', () => {
      collectContacts();
      ctSearch = search.value;
      renderContacts();
      // Re-rendering blows the focused element away — put the caret back so
      // typing a second character doesn't need a second click.
      const s2 = document.getElementById('ct-search');
      s2.focus();
      s2.setSelectionRange(s2.value.length, s2.value.length);
    });

    document.getElementById('ct-add').addEventListener('click', () => {
      collectContacts();
      // A new blank row can't match an active search, so it would be added and
      // then immediately hidden — clear the filter rather than lose it on screen.
      ctSearch = '';
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
      for (const c of shown) { if (e.target.checked) ctSelected.add(c.id); else ctSelected.delete(c.id); }
      collectContacts();
      renderContacts();
    });
    document.getElementById('ct-select-matching')?.addEventListener('click', () => {
      for (const c of matches) ctSelected.add(c.id);
      collectContacts();
      renderContacts();
    });
    document.getElementById('ct-clear-sel')?.addEventListener('click', () => {
      ctSelected.clear();
      collectContacts();
      renderContacts();
    });
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

    body().querySelectorAll('.ct-del').forEach((b) => b.addEventListener('click', async () => {
      if (!await Dialog.confirm(I18n.t('Delete this contact?'), { title: I18n.t('Delete'), okLabel: I18n.t('Delete'), danger: true })) return;
      collectContacts();
      contacts = contacts.filter((c) => c.id !== b.dataset.id);
      ctSelected.delete(b.dataset.id);
      renderContacts();
    }));
    document.getElementById('ct-import').addEventListener('click', () => document.getElementById('ct-file').click());
    document.getElementById('ct-file').addEventListener('change', async (e) => {
      const f = e.target.files[0]; if (!f) return;
      const text = await f.text();
      const r = await API.importContacts(text);
      toast(`Imported ${r.added} contact(s)`);
      await adoptImportedContacts();
      renderContacts();
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
      c.name = card.querySelector('.ct-name').value.trim();
      c.email = card.querySelector('.ct-email').value.trim();
    }
    contacts = contacts.filter((c) => c.email);
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
      case 'general':
        Object.assign(draft, { language: g('s-lang').value, uiFont: g('s-uifont').value, uiFontSize: +g('s-uifontsize').value, uiFontWeight: +g('s-uiweight').value, keepScreenOn: g('s-keepawake').checked, timeFormat: g('s-time').value, dateFormat: g('s-date').value, conversationView: g('s-convview').checked, conversationExpandAll: g('s-convexpand').checked, messagesPerPage: +g('s-perpage').value, syncBackfillLimit: +g('s-backfill').value, contentCacheLimit: +g('s-contentcache').value, searchAutocomplete: g('s-searchauto').checked, runFiltersOnLoad: g('s-runfilters').checked, deleteBehavior: g('s-delmode').value, markReadOnDelete: g('s-delread').checked, desktopNotifications: g('s-notify')?.checked ?? draft.desktopNotifications, swipeGestures: g('s-swipe').checked, swipeSwapDirection: g('s-swipedir').value === 'swapped' });
        break;
      case 'reading':
        Object.assign(draft, {
          readingPane: g('s-pane').value, autoMarkRead: g('s-amr').value, autoMarkReadDelay: +g('s-amr-delay').value,
          externalImages: g('s-ext').value, trustedDomains: g('s-trusted').value.split(/\r?\n/).map((x) => x.trim()).filter(Boolean),
          showDeleted: g('s-showdel').checked, unsubscribeButton: g('s-unsub').checked,
          unsubscribeBannerCompact: g('s-unsub-min').checked,
          messageFont: g('s-font').value, messageFontSize: +g('s-fontsize').value,
        });
        break;
      case 'compose':
        Object.assign(draft, { composeFormat: g('s-format').value, composeFont: g('s-compose-font').value, replyQuotePosition: g('s-quote').value, autosaveDraftSeconds: +g('s-autosave').value, requestReadReceipt: g('s-receipt').checked, spellcheck: g('s-spellcheck').checked });
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

  function renderTab() {
    ({ general: renderGeneral, reading: renderReading, compose: renderCompose, identities: renderIdentities, filters: renderFilters, folders: renderFolders, scheduler: renderScheduler, contacts: renderContacts, accounts: renderAccountsTab, security: renderSecurity, admin: renderAdmin, log: renderLog }[tab])();
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
    // Contacts tab view state starts clean on every open — a search left over
    // from last time would look like contacts having gone missing.
    ctSearch = '';
    ctSelected = new Set();
    ctSuggestOpen = false;
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
    state.contacts = await API.saveContacts(contacts);
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
