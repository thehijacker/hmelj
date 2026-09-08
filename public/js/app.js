// Hmelj — main app
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

const state = {
  settings: null,
  accounts: [],
  currentAccount: null, // account id, or 'all' for the unified view
  lastAccount: null, // last specific (non-'all') account visited — Compose's default context
  identities: [],
  contacts: [],
  // Named sets of addresses (server/contactGroups.js). Read by compose's
  // recipient autocomplete, which offers each one as a single `👥 Name` token;
  // the server is what turns that back into addresses, at send.
  contactGroups: [],
  // Searches pinned to the sidebar (server/store.js#getSavedSearches). Loaded
  // once at startup and re-read after every edit; each one is re-RUN on open,
  // so nothing here is a cached result.
  savedSearches: [],
  // Unread per saved search, keyed by its id — the badges on the 🔎 sidebar
  // rows. Filled by refreshUnread() from /api/unread, which counts them off the
  // same cache read the folder badges come from. A search the cache cannot
  // answer (a `body:` term with no full-text index) has NO KEY here, which is
  // deliberately different from having a 0: that row shows no badge at all.
  savedSearchUnread: {},
  // Which saved search the list is currently showing, if any. Deliberately NOT
  // folded into currentFolder: a saved search runs against a REAL folder (or the
  // unified view), and everything from the message fetch to "Move to…" reads
  // currentFolder expecting a path a server will answer for. This is only the
  // sidebar's notion of which row is lit.
  savedSearchId: null,
  // Messages waiting to come back (server/snooze.js). Pointers, not mail: the
  // messages themselves are in the account's snooze folder on the server.
  snoozed: [],
  // The row the keyboard is ON, which is not the same as the row that is OPEN
  // (openUid). Only public/js/shortcuts.js sets it; rowClassName draws it.
  cursorUid: null,
  folders: [],
  currentFolder: 'INBOX',
  page: 1,
  total: 0,
  messages: [],
  selected: new Set(),
  selectMode: false,
  openUid: null,
  query: '',
  // 'folder' (the default) reads the cache: this folder's newest cached
  // messages, matched on subject/from/to only. 'account' is the escalation the
  // search footer offers — every folder of the account, asked live, matching
  // message bodies too. Reset by any new search and by leaving the folder, so
  // it is never a mode you get stuck in (see searchScopeRow).
  searchScope: 'folder',
  // What the SERVER says actually answered the last search — 'cache', 'index',
  // 'folder', 'inboxes', 'account' or 'starred' (see server/index.js's two list
  // routes). 'index' is 'cache' plus the message bodies, on an account whose
  // full-text index is on.
  // searchScope above is what was ASKED for; this is what was done, and the two
  // genuinely differ: a body: term is answered live even at 'folder' scope. Only
  // this one is safe to describe to the user (searchScopeRow).
  searchScopeUsed: null,
  unreadOnly: false,
  // Toolbar's ★ (#btn-starred-only). Per-tab like unreadOnly, not a stored setting:
  // it narrows the list only, so unlike showMuted below there's nothing computed
  // server-side (badges, push) that has to agree with it.
  //
  // It is the one filter that also WIDENS scope, and does so differently per view:
  //   - All inbox      → every account, every folder that view already spans
  //   - an account's INBOX → INBOX and everything nested under it
  //   - any subfolder  → that folder and everything nested under it
  // The last two are the same rule, and the server does the widening (see
  // /api/messages/:folder) — a folder path here is just the root to search from.
  starredOnly: false,
  // "Show muted" toggle in the All-inbox toolbar. Confirmed polarity (asked directly,
  // not guessed): UNCHECKED (this default) means filtering IS active — unread mail from
  // whatever the notification scheduler (server/schedule.js, Settings' Scheduler tab)
  // currently has muted stays hidden from the list. Checking it reveals everything
  // regardless of schedule. This still matches "by default all is always displayed" for
  // anyone who's never touched the Scheduler tab, since filtering an empty mute-set
  // hides nothing either way — see loadMessages() (sends the INVERSE as the server's
  // `hideMuted` param) and the #btn-show-muted wiring below.
  //
  // The toggle also decides whether muted mail is COUNTED: every unread badge
  // (per account, "All inboxes", tab title, favicon, PWA/Android launcher) sums
  // the same folders the list is willing to show, so the badge can never count
  // mail the list is hiding — see server/unread.js. That's why it's a persisted
  // per-user setting (settings.showMuted, seeded into this field at boot) rather
  // than per-tab state: push notifications and the launcher badge are computed
  // server-side with no page open at all.
  showMuted: false,
  // How many messages are waiting in the send-later queue — drives the sidebar
  // badge. Per person, not per account (see SCHEDULED_FOLDER).
  scheduledCount: 0,
  // The last fetched queue, kept so renderList() can repaint the Scheduled view
  // without a round trip (see paintScheduled).
  scheduled: [],
  // Pending auto-mark-as-read, keyed by uid. A Map rather than the single timer
  // this used to be: a conversation opens several messages in one pane, each
  // expanded at its own moment, and each waits out its own delay (see
  // scheduleMarkRead). Leaving the pane clears all of them.
  markReadTimers: new Map(),
  // The row a Shift+click range extends FROM — the last row clicked without
  // Shift, whether that click opened it, Ctrl-picked it, or ticked it in select
  // mode. A uid, so it must be cleared on folder/account navigation: uids are
  // only unique WITHIN a folder, and a leftover 5 from one folder would
  // otherwise happily match a different message 5 in the next. Not found in the
  // current list = no anchor, which selectRangeTo handles.
  selectAnchorUid: null,
  // Authoritative total unread across every account, from GET /api/unread
  // (and kept live by the SSE payload + optimistic nudges). null until the
  // first fetch lands, which is when unreadTotal() falls back to the local
  // per-account sum. See refreshUnread().
  unreadTotal: null,
};

/** `onTap` makes the toast actionable — used where the fix needs a real user
 * gesture (e.g. an Android permission intent, which the OS refuses to open
 * from a timer). Without one the toast behaves exactly as it always has. */
/**
 * `actionLabel` turns the tap target into a named action ("UNDO") sitting
 * beside the message rather than the whole sentence being underlined — which,
 * on a phone and in a language whose words are longer than English's, was
 * three underlined lines of centred text and genuinely hard to read. Keeping
 * the message short and the affordance separate is what makes it legible.
 */
function toast(msg, ms = 2600, onTap = null, actionLabel = '') {
  const t = $('#toast');
  t.textContent = '';
  const label = document.createElement('span');
  label.className = 'toast-msg';
  label.textContent = msg;
  t.appendChild(label);
  const withAction = !!(onTap && actionLabel);
  if (withAction) {
    const action = document.createElement('span');
    action.className = 'toast-action';
    action.textContent = actionLabel;
    t.appendChild(action);
  }
  t.classList.toggle('has-action', withAction);
  t.hidden = false;
  t.classList.toggle('tappable', !!onTap);
  t.onclick = onTap ? () => { t.hidden = true; clearTimeout(t._timer); onTap(); } : null;
  clearTimeout(t._timer);
  t._timer = setTimeout(() => (t.hidden = true), ms);
}

/* ---------- per-device settings ----------
 * theme/uiFont/uiFontSize/uiFontWeight used to be regular synced settings —
 * one value shared by every device signed into the account, so changing the
 * font size on a desktop also changed it on a phone. That's backwards for
 * exactly these: a phone reasonably wants its own text size and possibly
 * its own theme. Kept in localStorage (per browser) instead of server
 * settings.json (per account) from here on; nothing else moved.
 * customThemeBg/customThemeFg (the 'custom' theme's two picked colors) are
 * the same kind of per-device choice — no reason a phone and a desktop
 * should be forced to share one custom palette either. */
/* The subset owned exclusively by the theme picker (showThemePicker), which
 * writes each change straight to localStorage as it's made. Settings has no
 * control for any of them, so its own Save must leave them alone rather than
 * write back the copy its draft happened to snapshot when it was opened. */
const THEME_DEVICE_KEYS = ['theme', 'customThemeBg', 'customThemeFg'];
// keepScreenOn is device-local for the same reason the font size is: whether
// the screen should stay lit is a property of the thing with the screen. A
// phone propped up reading mail and a desktop browser tab want opposite
// answers, and they share one account.
// The offline keys ride along for the same reason: how much mail this machine
// keeps on its own disk is a property of the machine, not of the login. A phone
// and a desktop sharing one account want different answers, and public/js/
// offline.js reads them straight out of localStorage — it runs before boot()
// has a settings object at all (and message.html never gets one).
const DEVICE_SETTINGS_KEYS = [...THEME_DEVICE_KEYS, 'uiFont', 'uiFontSize', 'uiFontWeight', 'keepScreenOn',
  'offlineEnabled', 'offlineMessages', 'offlineAttachments', 'offlineMaxMb'];
const DEVICE_SETTINGS_STORAGE_KEY = 'hmelj-device-settings';

// These keys were named 'hmail-*' before the app was renamed to Hmelj. Carry
// whatever a device already has over to the new names once, then drop the old
// ones: device settings hold the theme and the UI font, so starting from
// defaults would look like the app had forgotten how the user set it up. Runs
// at load, before boot() reads any of them.
(function migrateRenamedStorageKeys() {
  // Every device-local key the app has: the theme/font settings, the login
  // language, the remembered Settings tab and account, the two "we already
  // asked you this" flags, and the cached CodexaPush token.
  const moved = ['device-settings', 'lang', 'settings-tab', 'last-account',
    'notif-prompted', 'battery-prompted', 'codexa-push-token']
    .map((k) => [`hmail-${k}`, `hmelj-${k}`]);
  try {
    for (const [from, to] of moved) {
      const v = localStorage.getItem(from);
      if (v === null) continue;
      if (localStorage.getItem(to) === null) localStorage.setItem(to, v);
      localStorage.removeItem(from);
    }
  } catch { /* private mode / no storage at all — nothing to carry over */ }
})();

function loadDeviceSettings() {
  try { return JSON.parse(localStorage.getItem(DEVICE_SETTINGS_STORAGE_KEY) || '{}'); }
  catch { return {}; }
}
function saveDeviceSettings(patch) {
  const next = { ...loadDeviceSettings(), ...patch };
  localStorage.setItem(DEVICE_SETTINGS_STORAGE_KEY, JSON.stringify(next));
  Object.assign(state.settings, patch);
  return next;
}
/** Called once right after state.settings loads from the server. Applies this
 * device's own stored values over the server copy; the very first time a
 * given browser is seen (no localStorage entry yet) it seeds one from
 * whatever the server had — a pre-existing account's current look carries
 * over once, rather than every new device silently resetting to defaults —
 * and every device is free to diverge from there. */
function applyDeviceSettings() {
  const local = loadDeviceSettings();
  const seed = {};
  for (const k of DEVICE_SETTINGS_KEYS) {
    if (local[k] !== undefined) state.settings[k] = local[k];
    else seed[k] = state.settings[k];
  }
  if (Object.keys(seed).length) saveDeviceSettings(seed);
}

/** Every `state.settings = await API.saveSettings(patch)` call site needs
 * this instead of calling API.saveSettings directly — the server's response
 * is authoritative for everything EXCEPT the 4 device-local keys, which it
 * knows nothing about (or has a stale/shared value for). Without
 * re-applying them here, saving any unrelated setting — desktop
 * notifications, sort order, list layout, anything — would silently revert
 * this device's own theme/font back to whatever's on the server. */
async function saveServerSettings(patch) {
  const result = await API.saveSettings(patch);
  const local = loadDeviceSettings();
  for (const k of DEVICE_SETTINGS_KEYS) if (local[k] !== undefined) result[k] = local[k];
  state.settings = result;
  // The font settings may have just changed. Fire-and-forget: saving a setting
  // must not wait on a font download, and a failure here costs only the offline
  // copy, never the setting itself.
  ensureOfflineFonts();
  return result;
}

/* ---------- theme ---------- */
// Adding a plain preset theme = one new entry here + its [data-theme="id"]
// variable block in app.css — nothing else needs to change (the picker and
// applyTheme both read this list). 'custom' is the one
// exception — it has no static CSS block at all; its colors come from two
// user-picked colors instead (see deriveCustomTheme/applyCustomTheme below).
const THEMES = [
  { id: 'system', label: 'System' },
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
  { id: 'sepia', label: 'Sepia' },
  { id: 'contrast', label: 'High contrast' },
  { id: 'midnight', label: 'Midnight' },
  { id: 'purple', label: 'Purple' },
  { id: 'pink', label: 'Pink' },
  { id: 'red', label: 'Red' },
  { id: 'green', label: 'Green' },
  { id: 'custom', label: 'Custom' },
];
function resolveTheme(pref) {
  if (pref !== 'system') return pref;
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
/** Derives a full palette from just two user-picked colors (background,
 * foreground/text) via CSS color-mix() — accent/danger stay fixed at this
 * app's usual defaults (only bg/fg were asked for). Returns plain
 * {--var: value} pairs; color-mix() strings are valid custom-property
 * values, resolved lazily wherever they're actually used, so no JS-side
 * color-space math is needed here at all. */
function deriveCustomTheme(bg, fg) {
  return {
    '--bg': bg,
    '--surface': `color-mix(in srgb, white 8%, ${bg} 92%)`,
    '--surface-2': `color-mix(in srgb, white 16%, ${bg} 84%)`,
    '--text': fg,
    '--text-dim': `color-mix(in srgb, ${fg} 55%, ${bg} 45%)`,
    '--border': `color-mix(in srgb, ${fg} 18%, ${bg} 82%)`,
    '--accent': '#0b57d0',
    '--accent-soft': `color-mix(in srgb, #0b57d0 18%, ${bg} 82%)`,
    '--unread-bg': `color-mix(in srgb, white 8%, ${bg} 92%)`,
    '--read-bg': `color-mix(in srgb, ${fg} 4%, ${bg} 96%)`,
    '--hover': `color-mix(in srgb, ${fg} 8%, transparent)`,
    '--danger': '#c5221f',
    '--shadow': isLightColor(bg) ? '0 1px 3px rgba(0,0,0,.18)' : '0 1px 4px rgba(0,0,0,.6)',
  };
}
const CUSTOM_THEME_VARS = Object.keys(deriveCustomTheme('#000000', '#ffffff'));
function applyCustomTheme() {
  const vars = deriveCustomTheme(state.settings?.customThemeBg || '#1b1f24', state.settings?.customThemeFg || '#e3e6ea');
  const root = document.documentElement.style;
  for (const [k, v] of Object.entries(vars)) root.setProperty(k, v);
}
/** Inline style always wins over a stylesheet rule at equal specificity —
 * switching away from 'custom' to any other theme must explicitly drop these
 * inline overrides, or they'd silently keep overriding every other theme's
 * own CSS block forever after the first time Custom was ever picked. */
function clearCustomThemeOverrides() {
  const root = document.documentElement.style;
  for (const k of CUSTOM_THEME_VARS) root.removeProperty(k);
}
function applyTheme() {
  const resolved = resolveTheme(state.settings?.theme || 'system');
  document.documentElement.dataset.theme = resolved;
  if (resolved === 'custom') applyCustomTheme(); else clearCustomThemeOverrides();
  refreshOpenMessageTheme();
  // Native Android app shell's root-layout background (see MainActivity.kt's
  // JsBridge.setBackgroundColor()) — it shows through the WebView's top/left/right
  // safe-area margin, so it needs to track the real theme instead of staying
  // whatever fixed color the native layout XML defaults to. No-op in a real
  // browser/PWA, where window.AndroidApp doesn't exist at all.
  const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
  if (bg) window.AndroidApp?.setBackgroundColor?.(bg);
  // Keeps <meta name="theme-color"> in sync with the real resolved theme (not
  // just the OS's light/dark preference — see index.html's comment on that
  // tag). Best-effort for Android Chrome PWA's system nav-bar tinting
  // specifically: that's a known, currently-open Chromium bug independent of
  // whether this tag is correct (installed standalone PWAs can ignore
  // theme-color for the gesture nav bar entirely) — this fixes the tag itself
  // regardless, and gives Chrome the best chance of getting it right.
  const themeMeta = document.getElementById('theme-color-meta');
  if (bg && themeMeta) themeMeta.content = bg;
  // Native Android app shell's status/nav bar ICON color (JsBridge.setStatusBarAppearance)
  // — separate from setBackgroundColor above, which only controls what shows through
  // the transparent bar background, not whether its icons render light or dark. Chrome
  // derives this automatically from theme-color's own luminance for the PWA (why that
  // path already looked right); the native wrapper has no such automatic behavior at
  // all and needs telling explicitly, or it just keeps whatever the system default is
  // (light/white icons) regardless of the app's actual background — invisible against
  // Hmelj's own light themes specifically, which is exactly what was reported.
  if (bg) window.AndroidApp?.setStatusBarAppearance?.(isLightColor(bg));
}
/** Perceived luminance of a '#rrggbb' color (standard weighting) — true if it reads as
 * light enough to need dark icons/text for contrast against it. Computed from the
 * theme's real --bg value rather than a per-theme-name lookup table, so it stays
 * correct automatically for every current theme (and any future one) without needing
 * a second place to keep in sync with app.css's own color choices. */
function isLightColor(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
  if (!m) return true; // unparsable — default to light, matching this app's own default theme
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return (0.299 * r + 0.587 * g + 0.114 * b) > 140;
}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);

/** A message body's iframe bakes its colors into a static srcdoc at render
 * time (see MessageFrame.create in buildMessageCard) — changing the theme
 * afterward doesn't retroactively touch it, so without this the body stays
 * in whatever theme was active when it was opened. Every card carries the
 * options it was built from (card.__frameOpts); rebuilding just the iframes
 * here (not the whole message-view) avoids re-fetching or re-wiring anything
 * that hasn't changed. */
function refreshOpenMessageTheme() {
  if ($('#message-view')?.hidden) return;
  // Every open card, not one: with conversation view on the pane can hold
  // several message bodies at once. Each card parked its own build options on
  // itself when it was built (see buildMessageCard).
  for (const card of $$('#message-view .mv-card')) {
    const slot = $('.mv-body-slot', card);
    if (!slot || !card.__frameOpts) continue;
    slot.innerHTML = '';
    slot.appendChild(MessageFrame.create({ ...card.__frameOpts, ...themeColorsForFrame() }));
  }
}

/**
 * Re-renders every open message body with the CURRENT font settings.
 *
 * refreshOpenMessageTheme above rebuilds from each card's parked
 * `__frameOpts`, which were captured when the card was built — so on their own
 * they carry the font that was in force then, and changing the font in Settings
 * left whatever was already open looking exactly as before. Which reads as the
 * setting not working, since the message you are staring at is the one you
 * changed it for.
 */
function refreshOpenMessageFonts() {
  if ($('#message-view')?.hidden) return;
  const fontFamily = migrateFontValue(state.settings.messageFont);
  const fontSize = state.settings.messageFontSize || 15;
  const fontOverride = !!state.settings.messageFontOverride;
  for (const card of $$('#message-view .mv-card')) {
    if (card.__frameOpts) Object.assign(card.__frameOpts, { fontFamily, fontSize, fontOverride, fonts: state.customFonts });
  }
  refreshOpenMessageTheme();
}

/* ---------- theme picker dialog ---------- */
function closeThemePicker() {
  $('#theme-picker-backdrop')?.remove();
  document.removeEventListener('keydown', themePickerEscHandler);
}
function themePickerEscHandler(e) { if (e.key === 'Escape') closeThemePicker(); }

/** Inline style string for the Custom swatch's own live preview — same idea
 * as every other swatch's `[data-theme="id"]` (a real, live-themed miniature,
 * not a hardcoded color chip), just set directly as inline custom properties
 * on this one preview element instead of via a matching stylesheet rule,
 * since 'custom' has no static CSS block for `[data-theme="custom"]` to hook. */
function customSwatchStyle(bg, fg) {
  return Object.entries(deriveCustomTheme(bg, fg)).map(([k, v]) => `${k}:${v}`).join(';');
}

function showThemePicker() {
  closeThemePicker();
  const current = state.settings.theme || 'system';
  const customBg = state.settings.customThemeBg || '#1b1f24';
  const customFg = state.settings.customThemeFg || '#e3e6ea';
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop dialog-backdrop';
  backdrop.id = 'theme-picker-backdrop';
  backdrop.innerHTML = `
    <div class="modal dialog" role="dialog" aria-modal="true">
      <div class="dialog-title">${I18n.t('Theme')}</div>
      <div class="dialog-body">
        <div class="theme-grid">
          ${THEMES.filter((t) => t.id !== 'custom').map((t) => `
            <button type="button" class="theme-swatch${t.id === current ? ' active' : ''}" data-theme-value="${t.id}">
              <span class="theme-swatch-preview" data-theme="${resolveTheme(t.id)}"><span class="tsp-accent"></span></span>
              <span class="theme-swatch-label">${I18n.t(t.label)}</span>
            </button>`).join('')}
          <button type="button" class="theme-swatch${current === 'custom' ? ' active' : ''}" data-theme-value="custom">
            <span class="theme-swatch-preview" id="custom-swatch-preview" style="${customSwatchStyle(customBg, customFg)}"><span class="tsp-accent"></span></span>
            <span class="theme-swatch-label">${I18n.t('Custom')}</span>
          </button>
        </div>
        <div class="theme-custom-pickers" id="theme-custom-pickers" ${current === 'custom' ? '' : 'hidden'}>
          <label>${I18n.t('Background')} <input type="color" id="theme-custom-bg" value="${customBg}"></label>
          <label>${I18n.t('Foreground')} <input type="color" id="theme-custom-fg" value="${customFg}"></label>
        </div>
      </div>
      <div class="dialog-buttons"><button class="link-btn dialog-cancel">${I18n.t('Close')}</button></div>
    </div>`;
  document.body.appendChild(backdrop);

  const pickers = backdrop.querySelector('#theme-custom-pickers');
  backdrop.querySelectorAll('.theme-swatch').forEach((btn) => btn.addEventListener('click', () => {
    const value = btn.dataset.themeValue;
    backdrop.querySelectorAll('.theme-swatch').forEach((b) => b.classList.toggle('active', b === btn));
    pickers.hidden = value !== 'custom';
    saveDeviceSettings({ theme: value });
    applyTheme();
  }));
  // Native <input type="color"> fires 'input' continuously while dragging —
  // gives the same instant live-preview feel as every other swatch's plain
  // click, both for the real app (applyTheme) and this dialog's own swatch.
  const updateCustom = () => {
    const newBg = backdrop.querySelector('#theme-custom-bg').value;
    const newFg = backdrop.querySelector('#theme-custom-fg').value;
    saveDeviceSettings({ theme: 'custom', customThemeBg: newBg, customThemeFg: newFg });
    applyTheme();
    backdrop.querySelector('#custom-swatch-preview').setAttribute('style', customSwatchStyle(newBg, newFg));
  };
  backdrop.querySelector('#theme-custom-bg').addEventListener('input', updateCustom);
  backdrop.querySelector('#theme-custom-fg').addEventListener('input', updateCustom);
  backdrop.querySelector('.dialog-cancel').addEventListener('click', closeThemePicker);
  backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) closeThemePicker(); });
  document.addEventListener('keydown', themePickerEscHandler);
}

/* ---------- fonts (App font / Message font) ----------
 * Generic CSS family keywords, not specific named fonts like the old preset
 * list ("Arial", "Georgia", …) — every browser/WebView guarantees these
 * resolve to genuinely distinct installed fonts, unlike a specific name,
 * which silently depends on whatever the OS's own font-substitution table
 * happens to alias it to (often nothing visually different from the default
 * at all — confirmed the actual cause of "changing the font doesn't seem to
 * do anything" on Android). Custom admin-uploaded fonts (server/fonts.js)
 * are appended as their own family names — those DO resolve to a real,
 * specific typeface, since they're registered via an actual @font-face
 * rule, not OS name-substitution. */
const GENERIC_FONTS = [
  ['system-ui', 'System default'],
  ['serif', 'Serif'],
  ['sans-serif', 'Sans-serif'],
  ['monospace', 'Monospace'],
  ['cursive', 'Cursive'],
];
// Old specific-name presets this replaced — remapped lazily wherever a
// stored uiFont/messageFont value is read for display/apply, not rewritten
// in storage until the user next hits Save on that setting (simplest-
// correct: no migration script or version flag needed, self-heals per
// account/device the next time either setting is touched).
const FONT_MIGRATE = {
  Arial: 'sans-serif', Verdana: 'sans-serif', Tahoma: 'sans-serif', Roboto: 'sans-serif',
  Georgia: 'serif', 'Times New Roman': 'serif',
  'Courier New': 'monospace',
};
const GENERIC_FONT_IDS = new Set(GENERIC_FONTS.map(([id]) => id));
function migrateFontValue(v) {
  if (FONT_MIGRATE[v]) return FONT_MIGRATE[v];
  if (GENERIC_FONT_IDS.has(v)) return v;
  if ((state.customFonts || []).some((f) => f.family === v)) return v;
  return 'system-ui';
}
/** A generic keyword (serif, sans-serif, …) must NOT be quoted in CSS — a
 * quoted 'serif' is parsed as a literal (nonexistent) font family NAMED
 * "serif", not the generic keyword, and would silently fail to apply at
 * all. An actual font name (a custom uploaded family, which may contain
 * spaces) needs quoting instead, same as any font-family value normally
 * would. */
function fontFamilyCss(font) {
  return GENERIC_FONT_IDS.has(font) ? font : `'${font}', system-ui, sans-serif`;
}

/** Only 400/700 are kept as options — same root cause as the font-name fix
 * above: an intermediate weight like 500 ("Medium") only renders distinctly
 * if the actual substituted font ships a real Medium face, which generic
 * system-font aliases frequently don't expose even when the underlying font
 * file has one (confirmed the cause of "Normal and Medium look identical").
 * Regular + Bold are the two weights virtually every font, everywhere,
 * reliably provides. A still-stored old 500 (from before this changed) is
 * remapped down to 400 (closer to its old visual result than jumping up to
 * bold) — same lazy, no-migration-script approach as migrateFontValue. */
function migrateUiWeight(w) { return +w === 700 ? 700 : 400; }

/* ---------- UI chrome font (whole app, not the message-content pane) ---------- */
function applyUiFont() {
  const s = state.settings;
  if (!s) return;
  const font = migrateFontValue(s.uiFont);
  const root = document.documentElement.style;
  root.setProperty('--ui-font', fontFamilyCss(font));
  root.setProperty('--ui-scale', (s.uiFontSize || 14) / 14);
  root.setProperty('--ui-weight', migrateUiWeight(s.uiFontWeight));
}

/** Injects one <style> of @font-face rules for every admin-uploaded custom
 * font into the main document's own <head> — the App font picker's route to
 * an actual custom typeface (the sandboxed message iframe registers the
 * same fonts separately for the Message font picker, see messageFrame.js's
 * buildFontFaceCss — @font-face doesn't cross a srcdoc iframe boundary).
 * Called once at boot and again whenever the Admin tab uploads/deletes a
 * font, so this device picks up the change without a full reload. */
function applyCustomFontFaces() {
  let style = document.getElementById('custom-fonts-css');
  if (!style) {
    style = document.createElement('style');
    style.id = 'custom-fonts-css';
    document.head.appendChild(style);
  }
  style.textContent = MessageFrame.buildFontFaceCss(state.customFonts || []);
}
/**
 * Save the font files this device actually reads mail in, so they survive going
 * offline.
 *
 * Only the families the two font settings NAME, and only their real styles — at
 * most a handful of files. Which families those are is a question only this file
 * can answer, which is why offline.js takes the list rather than working it out:
 * it is a settings question, not a caching one. Passing the current list also
 * evicts whatever family was selected before.
 */
function ensureOfflineFonts() {
  const wanted = new Set([
    migrateFontValue(state.settings?.uiFont),
    migrateFontValue(state.settings?.messageFont),
  ]);
  const urls = (state.customFonts || [])
    .filter((f) => wanted.has(f.family))
    .flatMap((f) => Object.values(f.styles || {}).filter(Boolean));
  return Offline.cacheFonts(urls);
}

async function refreshCustomFonts() {
  try { state.customFonts = await API.fonts(); } catch { state.customFonts = state.customFonts || []; }
  applyCustomFontFaces();
}

/** The active theme's real colors, for the sandboxed message-body iframe (see
 * messageFrame.js) — so a message reads in Sepia/Contrast/Midnight tones
 * like the rest of the app, not always plain white regardless of theme. */
function themeColorsForFrame() {
  const cs = getComputedStyle(document.documentElement);
  const v = (name, fallback) => cs.getPropertyValue(name).trim() || fallback;
  return {
    bg: v('--surface', '#ffffff'),
    fg: v('--text', '#1f1f1f'),
    link: v('--accent', '#0b57d0'),
    dim: v('--text-dim', '#888888'),
  };
}

/* ---------- date formatting ---------- */
const MONTHS = { get list() { return I18n.months(); } };
function fmtDate(d, { long = false } = {}) {
  if (!d) return '';
  d = new Date(d);
  const s = state.settings;
  const pad = (n) => String(n).padStart(2, '0');
  let time;
  if (s.timeFormat === '12') {
    const h = d.getHours() % 12 || 12;
    time = `${h}:${pad(d.getMinutes())} ${d.getHours() < 12 ? 'AM' : 'PM'}`;
  } else {
    time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  const today = new Date();
  if (!long && d.toDateString() === today.toDateString()) return time;
  let date;
  switch (s.dateFormat) {
    case 'MM/DD/YYYY': date = `${pad(d.getMonth() + 1)}/${pad(d.getDate())}/${d.getFullYear()}`; break;
    case 'YYYY-MM-DD': date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; break;
    case 'D MMM YYYY': date = `${d.getDate()} ${MONTHS.list[d.getMonth()]} ${d.getFullYear()}`; break;
    default: date = `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`;
  }
  // Non-today rows in the compact list column also get the time now (used to
  // be date-only); the date cell has no nowrap so this wraps to two lines.
  return `${date} ${time}`;
}

/* ---------- folders ---------- */
const FOLDER_ICONS = { '\\Inbox': '📥', '\\Drafts': '📝', '\\Sent': '📤', '\\Junk': '🚫', '\\Trash': '🗑', '\\Archive': '📦' };
function folderIcon(f) {
  if (f.path.toUpperCase() === 'INBOX') return '📥';
  return FOLDER_ICONS[f.specialUse] || '📁';
}

/** The sidebar's account order, from settings.accountOrder (server-side, so
 * it's the same on every device — see server/store.js). Ids the saved order
 * doesn't mention keep their natural relative order and sort last, which is
 * what makes a newly added (or newly shared-in) account appear at the bottom
 * instead of silently vanishing from a list that never heard of it. */
function orderedAccounts(list) {
  const order = state.settings?.accountOrder;
  if (!order?.length) return list;
  // Rank of "not in the saved order" is order.length, not Infinity — two such
  // accounts would otherwise compare as Infinity - Infinity = NaN, which is
  // not a valid comparator result. Ties fall through to the original index.
  const rank = (a) => { const i = order.indexOf(a.id); return i === -1 ? order.length : i; };
  return list
    .map((a, i) => [a, i])
    .sort(([a, i], [b, j]) => (rank(a) - rank(b)) || (i - j))
    .map(([a]) => a);
}

/** Accounts eligible for active use (sidebar, unified view, sync) — disabled
 * accounts stay in state.accounts (Settings needs to list/re-enable them)
 * but are otherwise invisible everywhere else. */
function activeAccounts() {
  return orderedAccounts(state.accounts.filter((a) => !a.disabled));
}

/** EVERY account, disabled ones included, in the same order the sidebar shows
 * them — what Settings lists and every account picker in it selects from, so a
 * reordered sidebar doesn't leave the dropdowns in creation order. Disabled
 * accounts sort with the rest (they hold their saved position, see
 * currentAccountOrder) and simply appear wherever that puts them. */
function allAccounts() {
  return orderedAccounts(state.accounts);
}

/* ---------- account reordering (the ↕ button next to Compose) ----------
 * Edit mode swaps every account row's unread badge for up/down arrows and
 * suspends navigation (a click that both reorders and switches account is
 * nobody's idea of a good time). The new order is only PUT to the server when
 * edit mode is switched back off, and only if something actually moved. */
let accountEditMode = false;
let accountOrderBeforeEdit = null;

/** The full order to save, given `activeIds` — the ids of the rows actually on
 * screen, in the order they're now shown.
 *
 * Reorder mode only ever shows ACTIVE accounts, so a disabled one has no row to
 * drag and no say in the new sequence. Rather than sweeping those to the end
 * (which silently threw away a position the user had deliberately set, so
 * re-enabling the account left it stranded at the bottom), each keeps the exact
 * slot it already holds in the saved order, and the visible accounts fill the
 * remaining slots in their new order. Disable → reorder everything else →
 * re-enable therefore puts the account back where it was.
 *
 * An account with no saved slot at all — never ordered, or attached while
 * disabled — still goes last; there's no position to preserve for it. Stale ids
 * (accounts since deleted) are dropped on the way through. */
function mergedAccountOrder(activeIds) {
  const prev = state.settings?.accountOrder || [];
  const queue = [...activeIds];
  const out = [];
  for (const id of prev) {
    if (!state.accounts.some((a) => a.id === id)) continue; // account is gone — drop the stale id
    if (activeIds.includes(id)) { if (queue.length) out.push(queue.shift()); } // a visible slot: fill from the new order
    else out.push(id); // disabled — pinned exactly where it already was
  }
  out.push(...queue); // visible accounts that had no slot yet
  for (const a of state.accounts) if (!out.includes(a.id)) out.push(a.id); // ...and anything else, e.g. attached while disabled
  return out;
}

/** The order as it stands right now — what gets compared against, and saved, by
 * setAccountEditMode. */
function currentAccountOrder() {
  return mergedAccountOrder(activeAccounts().map((a) => a.id));
}

function moveAccount(id, delta) {
  // Works purely on the visible rows; mergedAccountOrder folds the result back
  // into the full order, disabled accounts included.
  const ids = activeAccounts().map((a) => a.id);
  const i = ids.indexOf(id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= ids.length) return;
  [ids[i], ids[j]] = [ids[j], ids[i]];
  state.settings.accountOrder = mergedAccountOrder(ids);
  renderAccounts();
}

async function setAccountEditMode(on) {
  accountEditMode = on;
  $('#btn-accounts-edit')?.classList.toggle('active', on);
  if (on) {
    accountOrderBeforeEdit = currentAccountOrder().join('\n');
    renderAccounts();
    return;
  }
  const ids = currentAccountOrder();
  renderAccounts();
  if (ids.join('\n') === accountOrderBeforeEdit) return; // nothing moved — don't write
  try {
    await saveServerSettings({ accountOrder: ids });
    toast('Order saved');
  } catch (e) {
    toast('Could not save order: ' + e.message, 5000);
  }
}

/* ---------- no mailbox yet ---------- */

/**
 * True when this user has no mailbox at all — neither one of their own nor one
 * shared with them. `/api/accounts` returns both (accounts.js#listAccounts), so
 * this single check covers a grantee who owns nothing, which is a real case: an
 * account can be shared with a Hmelj user who never adds one themselves.
 *
 * Everything mail-related is meaningless in that state, and used to prove it the
 * hard way — Compose, draft autosave, search and the rest all reached the server
 * and came back with "No mail account selected", one toast per attempt. The app
 * offers the wizard on first run and stops initialising if you cancel it, but
 * the UI stayed live afterwards, so a new user could wander straight into that
 * wall. Now the mail surfaces are simply not offered until there is a mailbox.
 */
function hasNoAccounts() {
  return !state.accounts?.length;
}

/**
 * Gate for anything that needs a mailbox. Returns false (and says why, and
 * offers the wizard) when there is none, so a caller reads as:
 *   if (!requireAccount()) return;
 */
function requireAccount() {
  if (!hasNoAccounts()) return true;
  toast(I18n.t('Add a mail account first'), 4000);
  addFirstAccount();
  return false;
}

/** Opens the wizard and, if a mailbox actually gets added, brings the app the
 *  rest of the way up — the same steps init() does after its own wizard. */
async function addFirstAccount() {
  const added = await Settings.accountWizard();
  if (!added) return false;
  state.accounts = await API.accounts();
  state.identities = await API.identities();
  Compose.setIdentities(state.identities);
  const active = activeAccounts();
  state.currentAccount = active.length > 1 ? 'all' : (active[0]?.id || 'all');
  applyAccountGate();
  renderAccounts();
  await loadFolders();
  await loadMessages();
  return true;
}

/**
 * Reflects the presence of a mailbox in the chrome. The class does the visual
 * half (app.css hides compose, search, refresh and select-mode); the guards on
 * the handlers do the other half, because hiding a control is not the same as
 * disabling it — a keyboard shortcut or a stale click still reaches the code.
 */
function applyAccountGate() {
  const none = hasNoAccounts();
  document.body.classList.toggle('no-accounts', none);
  if (none) renderNoAccountState();
}

/** The message list, when there is no mailbox to list. */
function renderNoAccountState() {
  const ul = $('#msg-list');
  if (!ul) return;
  ul.innerHTML = `<li class="no-account-state">
    <img class="no-account-mark" src="/icons/icon-mark.svg" alt="" width="88" height="88">
    <h2>${esc(I18n.t('No mail account yet'))}</h2>
    <p>${esc(I18n.t('Hmelj reads mailboxes you attach to it — your own IMAP server, Gmail, Outlook, an Exchange server. Add one and your mail appears here.'))}</p>
    <p><button class="send-btn" id="empty-add-account">${esc(I18n.t('Add mail account'))}</button></p>
    <p class="no-account-hint">${esc(I18n.t('Someone can also share one of their accounts with you — it shows up here on its own once they do.'))}</p>
  </li>`;
  $('#empty-add-account', ul)?.addEventListener('click', () => addFirstAccount());
}

function renderAccounts() {
  const ul = $('#account-list');
  ul.innerHTML = '';
  ul.classList.toggle('reordering', accountEditMode);
  const active = activeAccounts();
  if (active.length > 1) {
    const totalUnseen = unreadTotal();
    const li = document.createElement('li');
    li.className = 'account-row' + (state.currentAccount === 'all' ? ' active' : '');
    li.innerHTML = `<span class="acct-dot all">◉</span><span>All inboxes</span>` +
      (totalUnseen ? `<span class="f-count">${totalUnseen}</span>` : '');
    if (!accountEditMode) {
      li.addEventListener('click', () => switchAccount('all'));
      li.addEventListener('contextmenu', (e) => { e.preventDefault(); showAccountMenu('all', e.clientX, e.clientY); });
      bindLongPress(li, (x, y) => showAccountMenu('all', x, y));
    }
    ul.appendChild(li);
  }
  for (const a of active) {
    const li = document.createElement('li');
    li.className = 'account-row' + (state.currentAccount === a.id ? ' active' : '');
    li.dataset.acct = a.id;
    li.innerHTML = `<span class="acct-dot" style="background:${escAttr(a.color)}"></span>` +
      `<span class="acct-label" title="${escAttr(a.shared ? I18n.t('Shared by') + ' ' + a.ownerUsername : a.email)}">${esc(a.label)}</span>` +
      (a.shared ? `<span title="${escAttr(I18n.t('Shared by') + ' ' + a.ownerUsername)}">🔗</span>` : '') +
      // The other direction: an account of YOURS that other people can see.
      // 🔗 above means "someone shared this with me"; 👥 means "I've shared
      // this out", with the grantees in the tooltip. Only ever set on an
      // account you own — accounts.js#listSharedInAccounts deliberately drops
      // sharedWith for a grantee, since the full list is the owner's business.
      (!a.shared && a.sharedWith?.length
        ? `<span class="acct-shared" title="${escAttr(I18n.t('Shared with') + ': ' + a.sharedWith.map((s) => s.username).join(', '))}">👥</span>`
        : '') +
      (accountEditMode
        ? `<span class="acct-move-wrap">` +
          `<button class="acct-move" data-dir="up" title="${escAttr(I18n.t('Move up'))}">▲</button>` +
          `<button class="acct-move" data-dir="down" title="${escAttr(I18n.t('Move down'))}">▼</button></span>`
        : (a.unseen ? `<span class="f-count">${a.unseen}</span>` : ''));
    if (accountEditMode) {
      for (const b of $$('.acct-move', li)) {
        b.addEventListener('click', (e) => { e.stopPropagation(); moveAccount(a.id, b.dataset.dir === 'up' ? -1 : 1); });
      }
    } else {
      li.addEventListener('click', () => switchAccount(a.id));
      li.addEventListener('contextmenu', (e) => { e.preventDefault(); showAccountMenu(a.id, e.clientX, e.clientY); });
      bindLongPress(li, (x, y) => showAccountMenu(a.id, x, y));
    }
    ul.appendChild(li);
  }
  updateSilenceMarkers();
  updateUnreadIndicator();
}

/* ---------- "notifications are off here" markers ----------
 * Silencing isn't a flag of its own — it's the notification scheduler
 * (account.notificationSchedule / .folderNotificationSchedules, see
 * server/schedule.js), and what the sidebar shows is whether that schedule is
 * quiet RIGHT NOW: 'never' always, a custom schedule only outside its notify
 * window. Everything needed is already on state.accounts (GET /api/accounts
 * keeps both schedule fields — only credentials are stripped) and
 * ScheduleUtil is the shared client-side mirror of the server's evaluation,
 * so none of this costs an API call. */
let workFreeDateSet = null;

/** ScheduleUtil.isMutedNow() is synchronous and needs the work-free date set
 * handed to it; the set itself arrives asynchronously (GET /api/holidays,
 * cached per year inside ScheduleUtil). Kick it off once and repaint when it
 * lands — until then, only "skip holidays" schedules can read slightly wrong,
 * and only on an actual holiday. */
function ensureSilenceHolidays() {
  ScheduleUtil.ensureHolidaysLoaded().then((set) => {
    if (set === workFreeDateSet) return;
    workFreeDateSet = set;
    updateSilenceMarkers();
  }).catch(() => { /* offline/logged out — treat as no known holidays */ });
}

/** Mirrors settings.showMuted into state + the toolbar button. Called at boot
 * and whenever another device flips it (the settings-changed SSE event) — the
 * button is the only visible trace of a setting that also decides what every
 * unread badge counts, so it must never drift from the stored value. */
function applyShowMuted() {
  const on = !!state.settings?.showMuted;
  state.showMuted = on;
  const btn = $('#btn-show-muted');
  if (!btn) return;
  btn.classList.toggle('active', on);
  btn.setAttribute('aria-pressed', String(on));
}

function isQuietNow(sched) {
  return !!sched && ScheduleUtil.isMutedNow(sched, { workFreeDateSet });
}

/** 'account' — this account notifies nowhere right now; 'folder' — the
 * account itself is loud but at least one of its folders is quiet; null —
 * nothing silenced. A folder override REPLACES the account schedule rather
 * than merging with it (see server/schedule.js#resolveEffectiveSchedule), so
 * only an overridden folder can differ from its account — which is why the
 * partial case needs no folder list at all (the same shortcut
 * mutedFolderPairsFor's fast path takes). */
function accountSilence(a) {
  if (isQuietNow(a.notificationSchedule)) return 'account';
  for (const s of Object.values(a.folderNotificationSchedules || {})) if (isQuietNow(s)) return 'folder';
  // A temporary Mute is per folder by definition, so it can only ever make the
  // account partially quiet — never 'account'.
  const now = Date.now();
  for (const until of Object.values(a.folderMutes || {})) if (until > now) return 'folder';
  return null;
}

function silenceMarkerHtml(kind, title) {
  const partial = kind === 'folder';
  title = title || I18n.t(partial ? 'Some folders silenced' : 'Notifications silenced');
  return `<span class="mute-mark${partial ? ' partial' : ''}" title="${escAttr(title)}">🔕</span>`;
}

/** Adds/updates/removes one row's marker in place. Inserted BEFORE whatever
 * trails the row (the unread count, or the reorder arrows) so it stays next to
 * the label instead of after a folder row's right-aligned count. */
function setSilenceMarker(li, kind, title) {
  const cur = $('.mute-mark', li);
  if (!kind) { cur?.remove(); return; }
  const html = silenceMarkerHtml(kind, title);
  if (cur) { cur.outerHTML = html; return; }
  const tail = $('.f-count', li) || $('.acct-move-wrap', li);
  if (tail) tail.insertAdjacentHTML('beforebegin', html);
  else li.insertAdjacentHTML('beforeend', html);
}

/** Repaints every marker in the sidebar. Separate from the row rendering
 * because rows aren't always re-rendered: reconcileFolders() patches badges in
 * place, and a schedule boundary (22:00 arriving) has to flip markers with
 * nobody touching the sidebar at all — hence the timer in boot(). */
function updateSilenceMarkers() {
  for (const li of $$('#account-list li[data-acct]')) {
    const a = state.accounts.find((x) => x.id === li.dataset.acct);
    setSilenceMarker(li, a ? accountSilence(a) : null);
  }
  // Folder rows belong to the currently open account; the unified view's two
  // smart folders span every account and get no marker (acct() is undefined).
  const account = acct();
  for (const li of $$('#folder-list li[data-path]')) {
    // A temporary Mute is checked first and names its own end time in the
    // tooltip — that instant is the only thing that makes a mute different
    // from any other quiet period, and it's the thing the user will want to
    // know when they wonder why this folder is silent.
    const until = account ? ScheduleUtil.folderMutedUntil(account, li.dataset.path) : 0;
    if (until) { setSilenceMarker(li, 'account', I18n.t('Muted until') + ' ' + fmtDate(until)); continue; }
    const effective = account && ScheduleUtil.resolveEffectiveSchedule(account, li.dataset.path);
    setSilenceMarker(li, isQuietNow(effective) ? 'account' : null);
  }
}

/* ---------- tab title / favicon unread badge ----------
 * A pinned tab shows no title text and its icon never changes on its own —
 * a background desktop notification is easy to miss entirely if the tab
 * isn't the active one. This redraws the favicon with a small red dot (and
 * prefixes the title with the count) whenever total unread across active
 * accounts is nonzero, clearing back to plain the moment it's zero. Driven
 * off the same account.unseen numbers the sidebar badges use (kept fresh by
 * loadFolders/reconcileFolders/refreshUnread), so this just piggybacks
 * on renderAccounts() rather than polling on its own. */
const BASE_TITLE = document.title;
let faviconBadgeImg = null;
let faviconCanvas = null;

/** The one unread number this app displays anywhere.
 *
 * Comes from the server (GET /api/unread, see server/unread.js), which is
 * what fixed the counter being wrong: this used to be summed here from each
 * account's cached `unseen`, but nothing ever refreshed an account other than
 * the one currently selected — so with a specific account open, the "All
 * inboxes" row, the tab title and the Android launcher badge all sat frozen
 * at whatever the other accounts happened to be when last visited (and
 * counted as 0 for any account never visited this session).
 *
 * The local sum is kept only as the pre-first-fetch fallback and for
 * optimistic ±1 nudges between fetches (see adjustUnreadCounts). */
function unreadTotal() {
  if (state.unreadTotal != null) return state.unreadTotal;
  return activeAccounts().reduce((sum, a) => sum + (a.unseen || 0), 0);
}

function updateUnreadIndicator() {
  const total = unreadTotal();
  document.title = total > 0 ? `(${total > 99 ? '99+' : total}) ${BASE_TITLE}` : BASE_TITLE;
  drawFaviconBadge(total > 0);
  // The installed-PWA badge (desktop dock/taskbar, iOS home screen, Android
  // launcher for a WebAPK install) — the standard Badging API, which nothing
  // in this app used before. Its counterpart lives in sw.js, so the badge
  // also updates from a push with no page open at all; this call keeps it
  // right while the app IS open, including after a mark-read that happened
  // on some other device.
  setAppBadge(total);
  // Native Android app shell's launcher-icon badge (a separate project — see
  // its own MainActivity.kt#setUnreadBadgeCount). Piggybacking on this exact
  // function is what fixes the stale-badge bug: it already re-runs whenever
  // the unread total changes for ANY reason (a new push, but just as much a
  // background poll/SSE reconcile noticing a message was marked read from a
  // completely different device) — a badge driven only off push arrivals can
  // never reflect the second case, since nothing else ever tells it the
  // count went down. No-op in a real browser/PWA, where window.AndroidApp
  // doesn't exist at all.
  window.AndroidApp?.setUnreadBadgeCount?.(total);
}

/** Badging API, shared with sw.js (which sets it from a push when no page is
 * open). Everything about it is best-effort and permission-free: unsupported
 * browsers simply don't have it, and a rejected promise (Chrome does this
 * when the PWA isn't actually installed) is not worth surfacing. */
function setAppBadge(total) {
  try {
    if (total > 0) navigator.setAppBadge?.(total)?.catch?.(() => {});
    else navigator.clearAppBadge?.()?.catch?.(() => {});
  } catch { /* not supported here */ }
}

function drawFaviconBadge(showBadge) {
  const link = document.querySelector('link[rel="icon"]');
  if (!link) return;
  if (link.dataset.origHref === undefined) { link.dataset.origHref = link.href; link.dataset.origType = link.type; }
  if (!showBadge) {
    link.href = link.dataset.origHref;
    link.type = link.dataset.origType;
    return;
  }
  // The SVG source can't be drawn onto a canvas without its own decode step
  // (and reliably rasterizes at odd sizes across browsers), so the badge is
  // painted onto the PNG icon that already ships for the manifest instead.
  if (!faviconBadgeImg) {
    faviconBadgeImg = new Image();
    faviconBadgeImg.onload = () => drawFaviconBadge(showBadge);
    faviconBadgeImg.src = '/icons/icon-192.png';
    return;
  }
  if (!faviconBadgeImg.complete || !faviconBadgeImg.naturalWidth) return; // still loading; onload above retries
  if (!faviconCanvas) faviconCanvas = document.createElement('canvas');
  const size = 64;
  faviconCanvas.width = size; faviconCanvas.height = size;
  const ctx = faviconCanvas.getContext('2d');
  ctx.clearRect(0, 0, size, size);
  ctx.drawImage(faviconBadgeImg, 0, 0, size, size);
  const dotColor = getComputedStyle(document.documentElement).getPropertyValue('--danger').trim() || '#c5221f';
  const r = size * 0.27, cx = size - r * 0.9, cy = r * 0.9;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = '#fff';
  ctx.fill();
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.72, 0, Math.PI * 2);
  ctx.fillStyle = dotColor;
  ctx.fill();
  link.type = 'image/png';
  link.href = faviconCanvas.toDataURL('image/png');
}

async function switchAccount(id) {
  // Only when actually leaving "All inboxes" for a specific account — not
  // on every switch between two specific accounts, which should stay at
  // the same single "folder" depth for the hardware-back trap (see
  // navPush) rather than stacking up one entry per account visited.
  if (state.currentAccount === 'all' && id !== 'all') navPush();
  state.currentAccount = id;
  API.account = id === 'all' ? null : id;
  if (id !== 'all') {
    state.lastAccount = id;
    localStorage.setItem('hmelj-last-account', id);
  }
  state.currentFolder = 'INBOX';
  state.page = 1;
  renderAccounts();
  await loadFolders();
  await openFolder('INBOX');
}

const acct = () => state.accounts.find((a) => a.id === state.currentAccount);

async function loadFolders() {
  // No mailbox: there are no folders to list, and asking produces
  // "No mail account selected (missing ?account= parameter)" as a toast. The
  // guard belongs here rather than at the call sites because there are many of
  // them and they are easy to miss — Settings' Save, the 90-second refresh
  // (which turned this into a toast every 90 seconds, not just the one the
  // report mentioned), the reconnect handler, and every post-action refresh.
  if (hasNoAccounts()) {
    const ul = $('#folder-list');
    ul.innerHTML = '';
    state.folders = [];
    // Except the calendar, which needs no mailbox — a CalDAV server has nothing
    // to do with mail, and somebody who only ever added one would otherwise
    // have no way to reach it. app.css keeps this one row visible while
    // body.no-accounts hides the rest of the list.
    appendCalendarRow(ul);
    return;
  }
  const ul = $('#folder-list');
  const moveSel = $('#sel-move-target');

  if (state.currentAccount === 'all') {
    // Unified view: two smart folders spanning all accounts. "Move to…"
    // doesn't make sense here — accounts have different folder trees, so
    // there's no single target list to offer — hide it entirely.
    state.folders = [];
    ul.innerHTML = '';
    moveSel.innerHTML = '<option value="">Move to…</option>';
    moveSel.hidden = true;
    // "Show muted" only means anything in the unified view (server/index.js's
    // hideMuted filter is unified-only by design — a single account's own folder
    // view always shows its own unread regardless of schedule).
    const showMutedBtn = $('#btn-show-muted');
    if (showMutedBtn) showMutedBtn.hidden = false;
    for (const [key, label, icon] of [['INBOX', 'Inbox', '📥'], ['__SENT__', 'Sent', '📤']]) {
      const li = document.createElement('li');
      li.dataset.path = key;
      if (key === state.currentFolder) li.classList.add('active');
      li.innerHTML = `<span class="f-icon">${icon}</span><span>${label}</span>`;
      li.addEventListener('click', () => openFolder(key));
      ul.appendChild(li);
    }
    appendSavedSearchRows(ul);
    appendSnoozedRow(ul);
    appendScheduledRow(ul);
    appendOutboxRow(ul);
    appendCalendarRow(ul);
    // total unread badge per account is refreshed alongside
    refreshUnread();
    return;
  }

  try {
    state.folders = await API.folders();
  } catch (e) {
    toast('Cannot load folders: ' + e.message, 5000);
    return;
  }
  // Every account's number, not just this one's — the whole point of the
  // server-side total (see refreshUnread). Not awaited: the folder tree below
  // doesn't depend on it, and it repaints the sidebar itself when it lands.
  refreshUnread();
  renderAccounts();
  ul.innerHTML = '';
  moveSel.innerHTML = '<option value="">Move to…</option>';
  moveSel.hidden = false;
  const showMutedBtn = $('#btn-show-muted');
  if (showMutedBtn) showMutedBtn.hidden = true;
  for (const f of state.folders) {
    // `system` is Hmelj's own machinery, not a mailbox (server/index.js sets
    // it — today just the Snoozed folder). Skipped BEFORE the move target is
    // offered as well as before the row is drawn: filing a message into
    // Snoozed by hand would move it with nothing recorded to bring it back,
    // which is the one way to lose a message in there. The 🕰️ Snoozed row
    // below is how snoozed mail is meant to be reached, and it shows when
    // each message is due rather than just that it is gone.
    if (f.system) continue;
    moveSel.insertAdjacentHTML('beforeend', `<option value="${escAttr(f.path)}">${esc(f.path)}</option>`);
    if (f.hidden) continue;
    const li = document.createElement('li');
    li.dataset.path = f.path;
    if (f.path === state.currentFolder) li.classList.add('active');
    // Depth used to come from splitting the real path by delimiter, which
    // reflected the server's own (very inconsistent across providers)
    // nesting — now that the server normalizes every folder's display
    // parent to either "top-level" or "directly under INBOX" (see
    // folderTree.js#sortFolderTree), depth is always exactly 0 or 1, and
    // f.parent already reflects that directly — no path math needed here.
    const depth = f.parent ? 1 : 0;
    li.style.paddingLeft = 14 + depth * 14 + 'px';
    li.innerHTML = `<span class="f-icon">${folderIcon(f)}</span><span>${esc(f.name)}</span>` +
      (f.unseen ? `<span class="f-count">${f.unseen}</span>` : '');
    li.addEventListener('click', () => openFolder(f.path));
    li.addEventListener('contextmenu', (e) => { e.preventDefault(); showFolderMenu(f.path, e.clientX, e.clientY); });
    bindLongPress(li, (x, y) => showFolderMenu(f.path, x, y));
    ul.appendChild(li);
  }
  // Last, below the real mailboxes: none of these is one. See
  // appendSavedSearchRows, appendScheduledRow and appendCalendarRow.
  appendSavedSearchRows(ul);
  appendSnoozedRow(ul);
  appendScheduledRow(ul);
  appendOutboxRow(ul);
  appendCalendarRow(ul);
  updateSilenceMarkers();
}

/**
 * The four safe-area insets in px — the notch/status bar, the navigation bar,
 * and (in landscape) whichever side each of them has moved to.
 *
 * Read off the inline style index.html's probe writes onto <html>, NOT
 * getComputedStyle: a custom property whose value is an `env()` expression
 * comes back as the unresolved expression from there, so parseFloat would
 * quietly give 0 on exactly the devices this is for. The probe runs before any
 * of this and re-runs on rotation, so the inline value is both present and
 * current; 0 is the right answer when it is missing (desktop, and the native
 * Android shell, which insets its own WebView instead of telling the page).
 */
function safeInsets() {
  const st = document.documentElement.style;
  const px = (name) => {
    const v = parseFloat(st.getPropertyValue(name));
    return Number.isFinite(v) ? v : 0;
  };
  return { top: px('--sat'), bottom: px('--sab'), left: px('--sal'), right: px('--sar') };
}

/* ---------- shared right-click / long-press context menu ---------- */
// One .ctx-menu at a time, regardless of which kind opened it — opening any
// menu (folder or message) closes whatever else was open first.
// Fired once when the open menu goes away, however it went away — a choice, a
// tap outside, another menu opening on top. Lets a caller that AWAITS a choice
// (Compose.pickSendTime) resolve on dismissal instead of hanging forever.
let ctxMenuOnClose = null;

function closeCtxMenu() {
  $$('.ctx-menu').forEach((m) => m.remove());
  $$('.ctx-menu-backdrop').forEach((b) => b.remove());
  const cb = ctxMenuOnClose;
  ctxMenuOnClose = null; // cleared BEFORE calling: the callback may open another menu
  cb?.();
}

/** Builds+positions a .ctx-menu of `items` ({label, danger, onClick}) at (x, y), clamped to the viewport.
 * Closes on any tap outside it via a full-viewport transparent backdrop — NOT a
 * document-level click listener (the old approach): the message reading pane's
 * body renders inside a sandboxed <iframe> (see messageFrame.js), and a tap
 * landing inside that iframe fires in the IFRAME's own document, which never
 * bubbles up to a listener on the parent document at all — the 3-dot menu could
 * never be dismissed by tapping the (usually screen-filling) message body. A
 * backdrop element sits above the iframe in stacking order instead, so it
 * physically catches the tap regardless of what's underneath. Same idiom
 * #user-menu-backdrop already uses for the user menu sheet. */
function openCtxMenu(items, x, y, { onClose = null } = {}) {
  closeCtxMenu();
  ctxMenuOnClose = onClose;
  const backdrop = document.createElement('div');
  backdrop.className = 'ctx-menu-backdrop';
  backdrop.addEventListener('mousedown', closeCtxMenu);
  backdrop.addEventListener('contextmenu', (e) => { e.preventDefault(); closeCtxMenu(); });
  document.body.appendChild(backdrop);
  const menu = document.createElement('div');
  menu.className = 'ctx-menu';
  // A `disabled` item is an explanation rather than a choice: it stands where an
  // action the user came looking for would be and says why it isn't on offer (see
  // showFolderMenu's already-silenced-by-schedule case), which tells them more than
  // the row simply not being there.
  menu.innerHTML = items.map((it, i) => {
    const cls = [it.danger ? 'danger' : '', it.disabled ? 'ctx-note' : ''].filter(Boolean).join(' ');
    return `<button data-i="${i}"${cls ? ` class="${cls}"` : ''}${it.disabled ? ' disabled' : ''}>${I18n.t(it.label)}</button>`;
  }).join('');
  document.body.appendChild(menu);
  // Clamp into the safe area, not merely into the viewport. Two things were
  // wrong before: on a phone in landscape the menu could be positioned under
  // the camera cutout or the navigation bar, and — worse — a menu TALLER than
  // the screen got a negative `top` from `Math.min`, putting its first items
  // above the top edge with no way to scroll to them. The reading pane's ⋯
  // menu has a dozen entries, which is exactly that case on a landscape phone.
  //
  // .ctx-menu carries `overflow-y: auto` and a max-height of the whole safe
  // area; measuring AFTER that is applied is what makes the clamp below see
  // the height the menu will really be.
  const inset = safeInsets();
  const top = inset.top + 8, bottom = inset.bottom + 8;
  const left = inset.left + 8, right = inset.right + 8;
  const r = menu.getBoundingClientRect();
  // Math.max(left, …) as well as the min: on a narrow screen a menu wider than
  // the space left would otherwise be pushed off the LEFT edge instead.
  menu.style.left = Math.max(left, Math.min(x, innerWidth - right - r.width)) + 'px';
  menu.style.top = Math.max(top, Math.min(y, innerHeight - bottom - r.height)) + 'px';
  menu.querySelectorAll('button').forEach((btn) => btn.addEventListener('click', () => {
    // Picking an item is NOT a dismissal: the item's own handler is the answer.
    // This has to be cleared before closeCtxMenu(), which would otherwise fire
    // onClose first and let a waiting caller resolve "cancelled" ahead of it.
    ctxMenuOnClose = null;
    closeCtxMenu();
    // A disabled button never fires this, but it also carries no onClick — guarded
    // so a future non-disabled note item can't turn into a TypeError either.
    items[+btn.dataset.i].onClick?.();
  }));
}

/**
 * "Mark all as read" (a folder, an account, or every account) used to wait
 * on the full server round trip before anything visibly changed — fine for
 * a handful of messages, but a genuinely long wait for an inbox with
 * hundreds/thousands unread, since server/index.js's markAccountRead has to
 * touch every in-scope folder. This flips every currently-LOADED unread
 * message matching `matches(m)` to read immediately (same instant feel as
 * marking one message read — see mvToggleRead), then fires `apiCall()` in
 * the background rather than blocking on it.
 *
 * `apiCall()` must resolve to `{ marked, failedFolders, failedAccounts }`
 * (see server/index.js's mark-read routes) — failedFolders/failedAccounts
 * is what lets this revert exactly the messages that didn't actually get
 * marked server-side back to unread, rather than either lying about the
 * result or reverting everything over one folder's failure. A single-folder
 * call (API.markFolderRead) has no such partial-failure mode — it's either
 * fully marked or the whole promise rejects — so its caller below just
 * passes empty arrays for those two.
 */
async function markAllReadOptimistic(matches, apiCall) {
  const targets = state.messages.filter((m) => !m.seen && matches(m));
  for (const m of targets) { m.seen = true; adjustUnreadCounts(m, -1); }
  if (targets.length) renderList();
  try {
    const r = await apiCall();
    // NUL-joined, not a plain space — folder paths routinely contain spaces
    // themselves (same reasoning as schedule.js's pairKey), which a space
    // separator could collide on. Built at runtime, not typed as an escape
    // sequence, to avoid a known tool-call gotcha with literal NUL escapes.
    const sep = String.fromCharCode(0);
    const failedFolderKeys = new Set((r.failedFolders || []).map((f) => f.accountId + sep + f.folder));
    const failedAccountIds = new Set(r.failedAccounts || []);
    const reverted = targets.filter((m) => {
      const acctId = m.account?.id ?? null;
      return failedAccountIds.has(acctId) || failedFolderKeys.has(acctId + sep + m.folder);
    });
    if (reverted.length) {
      for (const m of reverted) { m.seen = false; adjustUnreadCounts(m, 1); }
      renderList();
    }
    const failedCount = (r.failedFolders?.length || 0) + (r.failedAccounts?.length || 0);
    if (failedCount) toast(`Marked ${r.marked} message(s) as read — ${failedCount} folder(s) failed and were reverted to unread`, 6000);
    else toast(r.marked ? `Marked ${r.marked} message(s) as read` : I18n.t('Nothing to do'));
    // Reconciles authoritative folder-badge counts either way (cheap); the
    // list itself is only reloaded when something needed reverting — the
    // optimistic update already matches reality otherwise, so reloading it
    // too would just be a pointless, visible re-render for nothing.
    await loadFolders();
    if (reverted.length) loadMessages();
  } catch (e) {
    // The request failed outright — nothing the server reported succeeded
    // at all, so revert everything this optimistically marked.
    for (const m of targets) { m.seen = false; adjustUnreadCounts(m, 1); }
    if (targets.length) renderList();
    toast('Mark as read failed: ' + e.message, 5000);
  }
}

/* ---------- temporary folder mute ----------
 * "Mute" in a folder's right-click / long-press menu: silence this one folder for a
 * while and let it come back on its own. Stored per account as
 * folderMutes[path] = the epoch-ms instant it ends (server/schedule.js#folderMutedUntil),
 * layered ON TOP of whatever notification schedule that folder otherwise follows rather
 * than replacing it — so a mute lapsing needs no cleanup, and setting one can't quietly
 * destroy a per-folder schedule the Scheduler tab configured.
 *
 * Deliberately the same consequences as a scheduled quiet period, not a weaker
 * "notifications only" flag: no push while it lasts, the sidebar's 🔕 marker, and
 * (unless "Show muted" is on) its unread stays out of the unified list and the account
 * badges — a folder that's muted but still lighting up every badge would be muted in
 * name only.
 *
 * Owner-only, matching the schedules it layers over: notification gating is evaluated
 * once per folder for the owner AND every grantee (server/sync.js#notifyNewMail), so a
 * shared-in account has no per-viewer mute to offer — hence the `shared` check below.
 */
const MUTE_DURATIONS = [
  ['30 minutes', 30],
  ['1 hour', 60],
  ['2 hours', 120],
  ['4 hours', 240],
  ['8 hours', 480],
  ['24 hours', 1440],
];

/** The next moment the clock reads HH:MM locally — later today if it's still ahead,
 * otherwise tomorrow. */
function nextLocalTime(hh, mm) {
  const t = new Date();
  t.setHours(hh, mm, 0, 0);
  if (t.getTime() <= Date.now()) t.setDate(t.getDate() + 1);
  return t.getTime();
}

/** Applies (or lifts, with until = null) a folder mute and repaints everything it
 * changes: the 🔕 markers, the unread badges (the folder's unread drops out of them
 * while it's muted) and, in the unified view with "Show muted" off, the list itself. */
async function setFolderMute(accountId, path, until) {
  const a = state.accounts.find((x) => x.id === accountId);
  if (!a) return;
  const prev = a.folderMutes || {};
  // Optimistic, so the marker flips on the same tap — reverted below if the
  // server refuses (a grantee who got here somehow, a deleted account).
  const next = { ...prev };
  if (until) next[path] = until; else delete next[path];
  a.folderMutes = next;
  updateSilenceMarkers();
  try {
    const r = await API.setFolderMute(accountId, path, until || null);
    a.folderMutes = r.folderMutes || {};
    toast(until ? `${I18n.t('Muted until')} ${fmtDate(until)}` : I18n.t('Notifications back on'));
  } catch (e) {
    a.folderMutes = prev;
    toast('Mute failed: ' + e.message, 5000);
  }
  updateSilenceMarkers();
  // loadFolders() refreshes the badges itself (it calls refreshUnread) — only the
  // other-account case has to ask for them separately.
  if (state.currentAccount === accountId) loadFolders(); else refreshUnread();
  if (state.currentAccount === 'all' && !state.showMuted) { state.page = 1; loadMessages(); }
}

/** Second-level menu: how long. Opened at the same spot the folder menu was, so on a
 * phone it lands under the same thumb that just long-pressed the folder. */
function showMuteMenu(accountId, path, x, y) {
  const items = MUTE_DURATIONS.map(([label, mins]) => ({
    label, onClick: () => setFolderMute(accountId, path, Date.now() + mins * 60e3),
  }));
  items.push({
    label: 'Until tomorrow morning',
    onClick: () => setFolderMute(accountId, path, nextLocalTime(8, 0)),
  });
  items.push({
    label: 'Until a set time…',
    onClick: async () => {
      const now = new Date(Date.now() + 60 * 60e3);
      const suggested = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
      const value = await Dialog.form(
        I18n.t('Mute') + ': ' + path,
        `<label class="dialog-label">${I18n.t('Silence notifications until')}</label>
         <input class="dialog-input" type="time" value="${escAttr(suggested)}">
         <div class="set-hint">${I18n.t('A time that has already passed today means that time tomorrow.')}</div>`,
        { okLabel: I18n.t('Mute'), getValue: (r) => r.querySelector('.dialog-input').value },
      );
      if (!value) return; // cancelled, or the picker left empty
      const [hh, mm] = value.split(':').map(Number);
      if (!Number.isFinite(hh) || !Number.isFinite(mm)) return;
      setFolderMute(accountId, path, nextLocalTime(hh, mm));
    },
  });
  openCtxMenu(items, x, y);
}

function showFolderMenu(path, x, y) {
  const items = [{
    label: 'Mark all as read',
    onClick: () => markAllReadOptimistic(
      (m) => m.folder === path && (m.account?.id ?? state.currentAccount) === state.currentAccount,
      async () => {
        const r = await API.markFolderRead(path);
        return { marked: r.marked, failedFolders: [], failedAccounts: [] };
      }
    ),
  }];
  // Mute sits between "mark read" and the destructive "Empty" — see the block above
  // for why it's hidden on a shared-in account rather than offered and then refused.
  const account = acct();
  if (account && !account.shared) {
    const until = ScheduleUtil.folderMutedUntil(account, path);
    // Three states, in priority order. A temporary Mute wins because it's the one
    // the user set by hand here and the one they'd come back to lift. Otherwise, if
    // the schedule already has this folder quiet right now — its own override, or
    // the account's, since an override REPLACES rather than merges — offering
    // "Mute…" would be offering to silence something that is already silent, so the
    // row explains instead of acting. (A manual mute laid over a quiet period would
    // only start mattering once the schedule turned notifications back on, which is
    // not what reaching for Mute means.)
    if (until) {
      items.push({ label: `🔔 ${I18n.t('Unmute')} — ${I18n.t('muted until')} ${fmtDate(until)}`, onClick: () => setFolderMute(account.id, path, null) });
    } else if (isQuietNow(ScheduleUtil.resolveEffectiveSchedule(account, path))) {
      items.push({ label: `🔕 ${I18n.t('Silenced by schedule')}`, disabled: true });
    } else {
      items.push({ label: `🔕 ${I18n.t('Mute…')}`, onClick: () => showMuteMenu(account.id, path, x, y) });
    }
  }
  // Emptying the account's main Inbox isn't offered at all — unlike every
  // other folder, there's no plausible "I meant to do that" reading of it,
  // just a single confirm dialog standing between one misclick and the
  // entire inbox being gone.
  if (path.toUpperCase() !== 'INBOX') {
    items.push({
      label: 'Empty', danger: true,
      onClick: async () => {
        if (!await Dialog.confirm(I18n.t(`Permanently delete ALL messages in "${path}"?`), { title: I18n.t('Empty'), okLabel: I18n.t('Empty'), danger: true })) return;
        try {
          const r = await API.emptyFolder(path);
          toast(`Deleted ${r.deleted} message(s)`);
          await loadFolders();
          if (state.currentFolder === path) loadMessages();
        } catch (e) { toast('Empty failed: ' + e.message); }
      },
    });
  }
  openCtxMenu(items, x, y);
}

/** Right-click / long-press on an account row (or the "All inboxes" row,
 * accountId 'all') — marks every unread message across every in-scope
 * folder for that account (or, for 'all', every active account) as read.
 * Server-side scope is scope.js#isUnreadScope: INBOX + subfolders, never
 * Sent/Drafts/hidden — see server/index.js's markReadScope. */
function showAccountMenu(accountId, x, y) {
  const items = [{
    label: 'Mark all as read',
    onClick: () => markAllReadOptimistic(
      accountId === 'all' ? () => true : (m) => (m.account?.id ?? state.currentAccount) === accountId,
      () => (accountId === 'all' ? API.markAllAccountsRead() : API.markAccountRead(accountId))
    ),
  }];
  // Only when there is something to open, and never on "All inboxes", which is
  // not one account and so has no one Drafts folder to go to. draftCounts is
  // refreshed with the folder list (see loadFolders), so this is a Map lookup
  // rather than a request made while a menu is waiting to appear.
  const drafts = accountId !== 'all' ? draftCounts.get(accountId) : null;
  if (drafts) {
    items.push({
      label: `${I18n.t('Open drafts')} (${drafts.total})`,
      onClick: () => openAccountDrafts(accountId, drafts.folder),
    });
  }
  openCtxMenu(items, x, y);
}

/** Goes to that account's Drafts folder, switching account first when the menu
 *  was opened on a row that is not the one being viewed — which is the usual
 *  case, since it is reachable from every account row and from the unified
 *  view. switchAccount lands on INBOX and reloads the folder list, so the
 *  folder move has to come after it rather than instead of it. */
async function openAccountDrafts(accountId, folder) {
  if (state.currentAccount !== accountId) await switchAccount(accountId);
  await openFolder(folder);
}

/* {accountId: {folder, total}} for every account with a non-empty Drafts
 * folder — what puts "Open drafts" in the account menu above. Filled by
 * refreshDraftState alongside the ✎ marks, from one request. */
const draftCounts = new Map();

/** Nudge the folder-list and account-sidebar unread badges by `delta` (±1) for message m's
 * own folder, using local arithmetic instead of a network round-trip. This matters because
 * firing a GET /api/folders in parallel with the PUT/DELETE that's still in flight is a
 * race — losing it means the fetch reads the server's unseen count from before the flag/
 * delete actually landed, and the badge freezes on the stale number until the next
 * scheduled poll (up to 90s later) silently corrects it. Local math is instant and, for the
 * single change this backs, always right; reconcileFolders() still runs afterward (once the
 * op is actually confirmed, not racing it) to true up any drift from another client. */
function adjustUnreadCounts(m, delta) {
  const folderPath = m.folder || state.currentFolder;
  const accountId = m.account?.id || (state.currentAccount !== 'all' ? state.currentAccount : null);
  const a = state.accounts.find((x) => x.id === accountId);
  // Does this folder feed the account badge? The server already decided (see
  // scope.js#isUnreadScope) and ships the answer per folder as `countsUnread`,
  // so this no longer re-derives that rule.
  //
  // The unified view has no folder list to look it up in, so it falls back to
  // the one distinction that actually matters there: the unified SENT view
  // lists messages from each account's sent folder, and marking one of those
  // read must not move the inbox badge. Everything else the unified view
  // lists is in-scope by construction (the server builds it from the same
  // predicate). Only an optimistic nudge either way — reconcileFolders()
  // trues it up against /api/unread immediately afterwards.
  let countsUnread = true;

  if (state.currentAccount === 'all') {
    countsUnread = folderPath !== a?.sentFolder && folderPath !== a?.draftsFolder;
  } else {
    const f = state.folders.find((x) => x.path === folderPath);
    countsUnread = false;
    if (f) {
      countsUnread = f.countsUnread !== false;
      f.unseen = Math.max(0, (f.unseen || 0) + delta);
      const li = $$('#folder-list li').find((x) => x.dataset.path === folderPath);
      const span = li?.querySelector('.f-count');
      if (f.unseen) {
        if (span) span.textContent = f.unseen;
        else li?.insertAdjacentHTML('beforeend', `<span class="f-count">${f.unseen}</span>`);
      } else {
        span?.remove();
      }
    }
  }

  if (a && countsUnread) {
    a.unseen = Math.max(0, (a.unseen || 0) + delta);
    // The "All inboxes" total moves with it. Without this the per-account
    // badge dropped instantly while the total (and the tab title, and both
    // app badges) sat unchanged until the next server round-trip.
    if (state.unreadTotal != null) state.unreadTotal = Math.max(0, state.unreadTotal + delta);
    renderAccounts();
  }
}

/** Toggle one message's read state — shared by the context menu and swipe gestures.
 * Optimistic: flips the row and re-renders immediately (before the IMAP round-trip even
 * starts) so a mobile swipe feels instant instead of leaving the row ambiguous for however
 * long the server call takes — then applies the flag change in the background, rolling the
 * row back and toasting if it actually fails. batchOp is called (not awaited) before the
 * flip on purpose: it reads state.messages synchronously to resolve each uid's folder/account
 * before yielding on the network call, so it must run against the still-unmodified message. */
async function quickToggleRead(m) {
  const prev = m.seen;
  const prevUnseen = m.threadUnseen;
  // A conversation row toggles as a whole (see rowUids): the badge moves by how
  // many of its messages actually change, not by one.
  const seen = m.threadUids ? rowUnread(m) : !prev;
  const changing = m.threadUids ? (seen ? m.threadUnseen : m.threadCount - m.threadUnseen) : 1;
  const op = batchOp(rowUids(m), (folder, u, acct) => API.flags(folder, u, seen ? ['\\Seen'] : [], seen ? [] : ['\\Seen'], acct));
  m.seen = seen;
  if (m.threadUids) m.threadUnseen = seen ? 0 : m.threadCount;
  adjustUnreadCounts(m, (seen ? -1 : 1) * changing);
  renderList();
  try {
    await op;
    // True up against the server now that the write is confirmed — catches drift
    // from another client. Scheduled, not called: the same POST also broadcasts
    // an SSE event back to this tab, and coalescing means one refresh instead of
    // the two identical /api/unread calls every single click used to cost.
    scheduleReconcile(2);
  } catch (e) {
    m.seen = prev;
    if (m.threadUids) m.threadUnseen = prevUnseen;
    adjustUnreadCounts(m, (seen ? 1 : -1) * changing);
    renderList();
    toast('Could not update message: ' + e.message);
  }
}

/** Delete one message — shared by the context menu and swipe gestures. Removes the
 * row immediately (same reasoning as quickToggleRead above — waiting on the IMAP
 * round-trip to see it happen is what makes a delete feel slow) and deletes on the
 * server in the background, restoring the row and toasting if that fails.
 *
 * `confirm: false` is for the swipe, which asks in a different currency: the
 * gesture is deliberate and long (past half the row), and what follows is an
 * offer to undo rather than a dialog to dismiss beforehand — but only where the
 * delete really is reversible, see swipeDeleteIsReversible(). */
async function quickDelete(m, { confirm = true } = {}) {
  const uids = rowUids(m);
  const prompt = uids.length > 1
    ? I18n.t('Delete this conversation ({n} messages)?').replace('{n}', uids.length)
    : I18n.t('Delete this message?');
  if (confirm && !await Dialog.confirm(prompt, { title: I18n.t('Delete'), okLabel: I18n.t('Delete'), danger: true })) return;
  const { folder, accountId } = msgCtx(m);
  const op = trackMutation(API.deleteMsgs(folder, uids, accountId));
  const idx = state.messages.indexOf(m);
  if (idx !== -1) state.messages.splice(idx, 1);
  // Was unread — deleting it takes it off the badge too, once per unread
  // message in the conversation.
  const unread = m.threadUids ? (m.threadUnseen || 0) : (m.seen ? 0 : 1);
  if (unread) adjustUnreadCounts(m, -unread);
  // Inside an open conversation this is one message of several: take its card
  // out and leave the rest of the stack alone. Otherwise the pane was showing
  // exactly what was just deleted.
  if (!dropOpenCard(m) && state.openUid === m.uid) closeMessage();
  renderList();
  let res;
  try {
    res = await op;
    // What was just deleted may have BEEN a draft (this is how one is thrown
    // away from the Drafts folder) or may have been a message with an unsent
    // answer waiting on it. Either way the ✎ marks and the accounts' draft
    // counts have moved, and nothing else on this path reloads the list.
    syncDraftMarks();
  } catch (e) {
    if (idx !== -1) state.messages.splice(idx, 0, m);
    if (unread) adjustUnreadCounts(m, unread);
    renderList();
    toast('Delete failed: ' + e.message);
    return;
  }
  // Outside the try on purpose: the delete has already succeeded by here, and
  // anything that goes wrong while OFFERING the undo must not be reported as
  // the delete having failed — which would put a row back that is genuinely
  // gone from the server.
  scheduleReconcile(); // picks up the real total/pager now that the delete is confirmed, without flashing "Loading…"
  offerUndoDelete(m, folder, accountId, res, uids);
}

/** Can a delete from this row be taken back? Decided BEFORE the delete, because
 * it's what the swipe uses to choose between a confirm dialog and an undo offer.
 *
 * 'trash' moves the message (recoverable, and the server hands back the uid it
 * landed under — see imapClient.js#uidMapOf); 'flag' only sets \Deleted and
 * leaves it in place (recoverable by clearing the flag). 'expunge' destroys it,
 * and so does deleting from inside the Trash folder itself whatever the setting
 * says — those two keep the confirmation, since nothing can bring the message
 * back afterwards. */
function deleteIsReversible(m) {
  const mode = state.settings?.deleteBehavior || 'trash';
  if (mode === 'expunge') return false;
  const { folder, accountId } = msgCtx(m);
  const acc = state.accounts.find((a) => a.id === (accountId || state.currentAccount));
  return !(acc?.trashFolder && folder === acc.trashFolder);
}

/**
 * A brief "tap to undo" after a delete, and the restore behind it.
 *
 * A move mints a new uid in the destination, so putting the message back means
 * naming the copy that is now in Trash — `uidMap` from the delete response is
 * the only thing that can (server/imapClient.js#uidMapOf). Without one (an
 * ancient server with no UIDPLUS, an expunge, a delete from Trash itself) there
 * is nothing to offer and nothing is shown: an undo that might not work is
 * worse than none.
 *
 * Nothing is re-inserted locally on the way back — the restored message has a
 * NEW uid again, so the row object we still hold is a dead handle. The list is
 * reconciled from the server instead.
 */
const UNDO_MS = 6000;
// Deletes offered under ONE undo. Swiping three messages away in three seconds
// is a single act as far as the user is concerned, and one toast per row would
// have meant each new one replacing the last — every message but the final one
// silently losing its undo. Reset once the offer expires.
let undoBatch = null;

function offerUndoDelete(m, folder, accountId, res, uids = [m.uid]) {
  // Everything the delete actually moved — a conversation row deletes all of
  // its messages, so the undo has to bring all of them back, not just the one
  // the row was drawn from.
  const trashUids = res?.action === 'moved' && res.destination
    ? uids.map((u) => res.uidMap?.[u]).filter((u) => u !== undefined) : [];
  // Whether to put the unread mark back (markReadOnDelete may have taken it
  // off on the way out; an undo that silently eats an unread message is not an
  // undo). For a conversation this is all-or-nothing: the list row knows HOW
  // MANY of its messages were unread, not which — so only a wholly-unread
  // conversation comes back unread, and anything mixed keeps what the server
  // has. The reconcile that follows shows the truth either way.
  const restoreUnread = m.threadUids ? m.threadUnseen === m.threadCount : !m.seen;
  const restore = trashUids.length
    ? async () => {
      const back = await trackMutation(API.move(res.destination, trashUids, folder, accountId));
      const restoredUids = trashUids.map((u) => back?.uidMap?.[u]).filter((u) => u !== undefined);
      if (restoreUnread && restoredUids.length) await API.flags(folder, restoredUids, [], ['\\Seen'], accountId);
    }
    : res?.action === 'flagged'
      ? () => trackMutation(API.flags(folder, uids, [], ['\\Deleted'], accountId))
      : null;
  if (!restore) return;

  if (!undoBatch) undoBatch = { items: [], timer: null };
  const batch = undoBatch;
  batch.items.push(restore);
  clearTimeout(batch.timer);
  // The offer's own lifetime, kept a touch longer than the toast so a tap on
  // the very last visible frame still finds the batch.
  batch.timer = setTimeout(() => { if (undoBatch === batch) undoBatch = null; }, UNDO_MS + 500);

  const n = batch.items.length;
  toast(n === 1 ? I18n.t('Message deleted') : `${I18n.t('Messages deleted')} (${n})`, UNDO_MS, async () => {
    clearTimeout(batch.timer);
    if (undoBatch === batch) undoBatch = null; // this batch is spent either way
    // Sequentially, and each on its own: one message that can't be put back
    // (its folder gone, the connection dropped mid-way) must not take the
    // others with it. Order doesn't matter — every message is moved back by
    // its own uid, independently of the rest.
    let failed = 0;
    let lastError = '';
    for (const fn of batch.items) {
      try { await fn(); } catch (e) { failed++; lastError = e.message; }
    }
    scheduleReconcile();
    if (!failed) toast(batch.items.length === 1 ? I18n.t('Message restored') : `${I18n.t('Messages restored')} (${batch.items.length})`);
    else if (failed === batch.items.length) toast('Restore failed: ' + lastError, 4000);
    else toast(`${I18n.t('Some messages could not be restored')} (${failed}/${batch.items.length})`, 4000);
  }, I18n.t('Undo'));
}

/* ---------- spam and archive ---------- */

/**
 * What "spam" or "archive" means for the account a row belongs to — or null,
 * which is what hides the menu entry.
 *
 * Two ways it can be null, and both matter: the account may have the folder set
 * to (None) in Settings › Folders, and it may name a folder that isn't there —
 * an account added before this existed can carry `junkFolder: 'Junk'` on a
 * server with no such folder. `hasJunk`/`hasArchive` are the server's answer to
 * both (index.js#withRefileBoxes), checked against that account's real folder
 * list. Deliberately not re-derived here from `state.folders`: that holds the
 * folders of the ONE account in the sidebar, and is empty in the unified view —
 * which is exactly where the wrong entries showed up.
 */
function refileFor(m, box) {
  if (!m) return null;
  const { folder, accountId } = msgCtx(m);
  const acc = state.accounts.find((a) => a.id === (accountId || state.currentAccount));
  if (!acc) return null;
  const target = box === 'junk' ? acc.junkFolder : acc.archiveFolder;
  if (!target || !(box === 'junk' ? acc.hasJunk : acc.hasArchive)) return null;
  // `here` — the message is already in that folder, so the action is the way
  // back rather than the way in. It is the same route either way.
  return { box, target, folder, accountId, here: folder === target };
}

const REFILE_TEXT = {
  junk: { to: 'Mark as spam', back: 'Not spam', doneTo: 'Marked as spam', doneBack: 'Moved out of Junk' },
  // 'Move to Archive', not plain 'Archive': the dictionary already translates
  // the bare word as the FOLDER's name (sl. 'Arhiv'), which would read as a
  // noun where a menu wants a verb — and i18n.js translates by whole text node,
  // so the two cannot mean different things.
  archive: { to: 'Move to Archive', back: 'Move out of Archive', doneTo: 'Archived', doneBack: 'Moved out of Archive' },
};

/** The Junk/Archive entries for a menu, in the order they belong, leaving out
 *  whichever of the two this account has no folder for. */
function refileMenuItems(m) {
  const items = [];
  for (const box of ['junk', 'archive']) {
    const r = refileFor(m, box);
    if (!r) continue;
    items.push({ label: r.here ? REFILE_TEXT[box].back : REFILE_TEXT[box].to, onClick: () => quickRefile(m, box) });
  }
  return items;
}

/**
 * Files a row into Junk/Archive, or sends it back where it came from.
 *
 * Built the same way as quickDelete: the row leaves the list immediately and
 * the server call is awaited afterwards, so the list never sits still waiting
 * for a round trip — and is put back exactly as it was if the call fails.
 */
async function quickRefile(m, box) {
  const r = refileFor(m, box);
  if (!r) return;
  const uids = rowUids(m);
  const op = trackMutation(API.refile(r.folder, uids, box, r.here, r.accountId));
  const idx = state.messages.indexOf(m);
  if (idx !== -1) state.messages.splice(idx, 1);
  // Same bookkeeping a delete does: the messages are leaving this folder, so
  // they leave its unread badge with it. The destination's own count is fixed
  // by the sync the server forces on it.
  const unread = m.threadUids ? (m.threadUnseen || 0) : (m.seen ? 0 : 1);
  if (unread) adjustUnreadCounts(m, -unread);
  if (!dropOpenCard(m) && state.openUid === m.uid) closeMessage();
  renderList();
  let res;
  try {
    res = await op;
  } catch (e) {
    if (idx !== -1) state.messages.splice(idx, 0, m);
    if (unread) adjustUnreadCounts(m, unread);
    renderList();
    // 'Move failed: ' is an existing translated PREFIX (i18n.js#prefixes), so
    // the server's own sentence — "No Junk folder is set for this account" —
    // still reads as itself after it.
    toast('Move failed: ' + e.message, 5000);
    return;
  }
  scheduleReconcile();
  offerUndoRefile(r, res);
}

/**
 * "Marked as spam · Undo".
 *
 * The undo is the same route run the other way, on the uids the messages landed
 * under in the destination (`uidMap` — see offerUndoDelete for the same idea).
 * Coming back out of Junk it is the server's own ledger that decides where each
 * message goes, so an undo puts them back in the folder they were marked from,
 * not merely in the Inbox.
 */
function offerUndoRefile(r, res) {
  const text = REFILE_TEXT[r.box];
  const done = I18n.t(r.here ? text.doneBack : text.doneTo);
  const moves = (res?.moves || []).filter((mv) => mv.uidMap);
  if (!moves.length) { toast(done); return; }
  toast(done, UNDO_MS, async () => {
    try {
      for (const mv of moves) {
        const landed = mv.uids.map((u) => mv.uidMap[u]).filter((u) => u !== undefined);
        if (landed.length) await trackMutation(API.refile(mv.target, landed, r.box, !r.here, r.accountId));
      }
      scheduleReconcile();
      toast(I18n.t('Message restored'));
    } catch (e) {
      scheduleReconcile();
      toast('Undo failed: ' + e.message, 4000);
    }
  }, I18n.t('Undo'));
}

/** Quick actions for a single message row — right-click on desktop, long-press on mobile (see bindLongPress). */
/* ---------- unfinished replies (see server/draftLinks.js) ----------
 *
 * A reply started and left unsent used to be invisible from the message it
 * answers: the only trace of it was a row in the Drafts folder, to be found by
 * subject. The list now draws a ✎ against the message itself, and the row's own
 * menu continues or discards the draft.
 *
 * Held as a flat Map keyed by account+folder+uid, because that is what a row
 * knows about itself — the unified view mixes accounts in one list, so there is
 * no ambient account to key on. Small by nature: one entry per open draft.
 */
const draftLinks = new Map();

function draftLinkKey(accountId, folder, uid) { return `${accountId} ${folder} ${uid}`; }

/** The unfinished answer to this ROW, if there is one. A conversation row is
 *  addressed by its own uid like every other row action (msgCtx), so a draft
 *  answering an older message in the same thread is shown against that message
 *  and not against the whole conversation. */
function draftLinkFor(m) {
  if (!draftLinks.size) return null;
  const { folder, accountId } = msgCtx(m);
  const acct = accountId || state.currentAccount;
  return draftLinks.get(draftLinkKey(acct, folder, m.uid)) || null;
}

/** Re-reads both small tables in one request. Cheap enough to do on every list
 *  load, and that is also the only way a draft saved in ANOTHER tab shows up
 *  here. Never allowed to break a list render: without it the rows simply lack
 *  their mark and the account menu its entry. */
async function refreshDraftState() {
  try {
    const { links, counts } = await API.draftState();
    draftLinks.clear();
    for (const l of links || []) {
      draftLinks.set(draftLinkKey(l.original.accountId, l.original.folder, l.original.uid), l);
    }
    draftCounts.clear();
    for (const [id, info] of Object.entries(counts || {})) draftCounts.set(id, info);
  } catch { /* offline, or the server is older than this feature — no marks, no harm */ }
}

/** Re-reads the links and repaints the list only if the SET of marked messages
 *  changed. Called by the composer as it closes — saving, sending or discarding
 *  a draft all change whether a row wears a ✎, and the list is usually sitting
 *  right behind the window. Comparing keys is the right test: a new draft uid
 *  for the same original changes what the menu opens, which is refreshed
 *  regardless, but not what is drawn. */
async function syncDraftMarks() {
  const before = [...draftLinks.keys()].sort().join('|');
  await refreshDraftState();
  if ([...draftLinks.keys()].sort().join('|') !== before) renderList();
}

/** Opens the draft that answers `m` in the composer, with its reply linkage
 *  restored — see Compose.editDraft's second argument for why that matters. */
async function continueDraft(link) {
  try {
    const msg = await API.message(link.draftFolder, link.draftUid, false, link.draftAccountId);
    msg.__folder = link.draftFolder;
    msg.__account = link.draftAccountId;
    Compose.editDraft(msg, link);
  } catch (e) {
    // The usual cause is a draft deleted elsewhere since the list was drawn.
    toast(I18n.t('Could not open that draft') + ': ' + e.message, 6000);
    await refreshDraftState();
    renderList();
  }
}

async function discardLinkedDraft(link) {
  if (!await Dialog.confirm(I18n.t('Discard the unsent draft for this message?'),
    { title: I18n.t('Discard draft'), okLabel: I18n.t('Discard'), danger: true })) return;
  try {
    await API.deleteMsgs(link.draftFolder, [link.draftUid], link.draftAccountId);
    toast(I18n.t('Draft discarded'));
  } catch (e) {
    toast(I18n.t('Could not discard that draft') + ': ' + e.message, 6000);
  }
  await refreshDraftState();
  renderList();
  loadFolders();
}

/** The ✎ on a row that has an unfinished answer waiting. */
function draftMarkHtml(m) {
  const link = draftLinkFor(m);
  if (!link) return '';
  const label = link.kind === 'forward'
    ? I18n.t('You have an unsent forward of this message')
    : I18n.t('You have an unsent reply to this message');
  return `<span class="m-draftmark" title="${escAttr(label)}">✎</span>`;
}

function showMessageMenu(m, x, y) {
  openCtxMenu([
    // A conversation row acts as a whole (rowUids), so the label has to read
    // off the same aggregate the row draws — not just its newest message.
    { label: rowUnread(m) ? 'Mark as read' : 'Mark as unread', onClick: () => quickToggleRead(m) },
    // Junk and Archive, whichever of the two this account has a folder for —
    // and each of them says which way it goes, since the same entry moves a
    // message out again when you are already looking at that folder.
    ...draftMenuItems(m),
    ...refileMenuItems(m),
    ...snoozeMenuItems(m, x, y),
    { label: 'Delete', danger: true, onClick: () => quickDelete(m) },
  ], x, y);
}

/** Nothing at all when there is no unfinished answer to this message — which is
 *  almost every row, so this must not add a dead entry to every menu. */
function draftMenuItems(m) {
  const link = draftLinkFor(m);
  if (!link) return [];
  return [
    { label: link.kind === 'forward' ? 'Continue unsent forward' : 'Continue unsent reply',
      onClick: () => continueDraft(link) },
    { label: 'Discard unsent draft', danger: true, onClick: () => discardLinkedDraft(link) },
  ];
}

/* ---------- snooze (see server/snooze.js) ----------
 * Take a message out of the Inbox now and have it come back at a chosen time.
 * The message really moves, into the account's snooze folder — so it is out of
 * the way on the phone and in every other client too, not only here.
 */
const SNOOZED_FOLDER = '__SNOOZED__';

/** "Snooze", or "Un-snooze" when the row already is one. Nothing at all in the
 *  places where the idea makes no sense: a message already in Drafts or Trash,
 *  and the pseudo-folders, which hold no real mail. */
function snoozeMenuItems(m, x, y) {
  if (state.currentFolder.startsWith('__')) return [];
  const { folder, accountId } = msgCtx(m);
  const acct = accountId || (state.currentAccount !== 'all' ? state.currentAccount : null);
  const snoozeFolder = state.accounts.find((a) => a.id === acct)?.snoozeFolder;
  if (snoozeFolder && folder === snoozeFolder) {
    return [{ label: 'Un-snooze', onClick: () => unsnoozeRow(m) }];
  }
  return [{ label: 'Snooze…', onClick: () => snoozeRow(m, x, y) }];
}

async function snoozeRow(m, x, y) {
  // The same picker the composer uses for Send later — one list of presets and
  // one custom date/time dialog, so the two can never drift apart.
  const at = await Compose.pickSendTime(x, y, { mode: 'snooze' });
  if (!at) return;
  let addCalendar = false;
  // Only asked when there is somewhere to put it: a question with one possible
  // answer is not a question. Cancelling the dialog abandons the whole snooze,
  // which is why neither button is "no" — both of them snooze.
  if (hasWritableCalendar()) {
    const answer = await Dialog.choose(I18n.t('Put a reminder in your calendar for that time as well?'), {
      title: I18n.t('Snooze'),
      buttons: [
        { label: I18n.t('Just snooze'), value: 'plain' },
        { label: I18n.t('Snooze and remind me'), value: 'calendar', primary: true },
      ],
    });
    if (!answer) return; // cancelled
    addCalendar = answer === 'calendar';
  }
  const uids = rowUids(m);
  // The ROW's own folder and account, not the view's. In "All inboxes" there is
  // no ambient account and each row can belong to a different one — the same
  // resolution every other row action goes through (see quickRefile).
  const { folder, accountId } = msgCtx(m);
  try {
    await API.snooze(folder, uids, at, addCalendar, accountId);
    toast(I18n.t('Snoozed until {when}').replace('{when}', fmtDate(at, { long: true })));
    await loadMessages();
    loadFolders();
  } catch (e) {
    toast(I18n.t('Could not snooze that') + ': ' + e.message, 6000);
  }
}

async function unsnoozeRow(m) {
  const { folder, accountId } = msgCtx(m);
  const rec = (state.snoozed || []).find((s) => String(s.uid) === String(m.uid)
    && s.folder === folder && (!accountId || s.accountId === accountId));
  if (!rec) return toast(I18n.t('That message is not snoozed — move it yourself'), 5000);
  try {
    await API.wakeSnoozed(rec.id);
    toast(I18n.t('Back in your inbox'));
    await refreshSnoozed();
    await loadMessages();
    loadFolders();
  } catch (e) {
    toast(I18n.t('Could not bring that back') + ': ' + e.message, 6000);
  }
}

async function refreshSnoozed() {
  // Non-fatal: without it the sidebar badge is stale, which is not a reason to
  // break whatever else the caller was doing.
  state.snoozed = await API.snoozed().catch(() => []);
  paintSnoozedBadge();
}

function appendSnoozedRow(ul) {
  const n = (state.snoozed || []).length;
  if (!n && state.currentFolder !== SNOOZED_FOLDER) return; // nothing snoozed: no row at all
  const li = document.createElement('li');
  li.dataset.path = SNOOZED_FOLDER;
  if (state.currentFolder === SNOOZED_FOLDER) li.classList.add('active');
  li.innerHTML = '<span class="f-icon">🕰️</span><span>Snoozed</span>';
  if (n) li.insertAdjacentHTML('beforeend', `<span class="f-count">${n}</span>`);
  li.addEventListener('click', () => openFolder(SNOOZED_FOLDER));
  ul.appendChild(li);
}

function paintSnoozedBadge() {
  const li = $(`#folder-list li[data-path="${SNOOZED_FOLDER}"]`);
  if (!li) return; // sidebar not built yet — appendSnoozedRow paints it from state
  const span = $('.f-count', li);
  const n = (state.snoozed || []).length;
  if (n) {
    if (span) span.textContent = n;
    else li.insertAdjacentHTML('beforeend', `<span class="f-count">${n}</span>`);
  } else span?.remove();
}

/**
 * The Snoozed view. Like the Scheduled one it is not backed by state.messages —
 * these are pointers to mail sitting in a folder on the server, listed by when
 * they come back rather than by when they arrived.
 */
function paintSnoozed() {
  const ul = $('#msg-list');
  const list = state.snoozed || [];
  state.total = list.length;
  renderPager({ total: list.length, page: 1, pageSize: Math.max(list.length, 1) });
  if (!list.length) {
    ul.innerHTML = `<li class="msg-list-loading">${esc(I18n.t('Nothing snoozed. Right-click a message to snooze it.'))}</li>`;
    return;
  }
  ul.innerHTML = '';
  for (const item of list) ul.appendChild(snoozedRow(item));
}

function snoozedRow(item) {
  const li = document.createElement('li');
  li.className = 'msg-row';
  li.dataset.uid = item.id;
  // Overdue means the runner is working on it (or is about to). Only a repeated
  // failure is worth colouring differently, which lastError is what shows.
  const late = item.wakeAt < Date.now() - 60e3;
  const when = late ? I18n.t('Coming back…') : fmtDate(item.wakeAt, { long: true });
  const a = state.accounts.find((x) => x.id === item.accountId);
  const chip = a
    ? `<span class="acct-chip acct-chip-static" style="--chip:${escAttr(a.color)}" title="${escAttr(a.label)}">${esc(acctInitials(a.label))}</span>`
    : '';
  li.innerHTML = `
    ${chip}<span class="m-from">${esc(item.fromName || item.fromAddr || '—')}</span>
    <span class="m-subject" data-no-i18n>${esc(item.subject || '(no subject)')}</span>
    ${item.calendarUid ? `<span class="m-attach" title="${escAttr(I18n.t('Has a calendar reminder'))}">📅</span>` : ''}
    <span class="m-date m-when${late ? ' late' : ''}" title="${escAttr(when)}">${esc(when)}</span>`;
  const menu = (x, y) => showSnoozedMenu(item, x, y);
  li.addEventListener('contextmenu', (e) => { e.preventDefault(); menu(e.clientX, e.clientY); });
  bindLongPress(li, menu);
  // A plain click is the obvious "I want it now" gesture on a list whose rows
  // cannot be opened — the message is not in a folder this view can read.
  li.addEventListener('click', () => wakeSnoozedNow(item));
  return li;
}

function showSnoozedMenu(item, x, y) {
  openCtxMenu([
    { label: 'Bring it back now', onClick: () => wakeSnoozedNow(item) },
    { label: 'Snooze until…', onClick: async () => {
      const at = await Compose.pickSendTime(x, y, { mode: 'snooze', current: item.wakeAt });
      if (!at) return;
      try {
        await API.resnooze(item.id, at);
        await refreshSnoozed();
        if (state.currentFolder === SNOOZED_FOLDER) paintSnoozed();
        toast(I18n.t('Snoozed until {when}').replace('{when}', fmtDate(at, { long: true })));
      } catch (e) { toast(I18n.t('Could not change that') + ': ' + e.message, 6000); }
    } },
  ], x, y);
}

async function wakeSnoozedNow(item) {
  try {
    await API.wakeSnoozed(item.id);
    await refreshSnoozed();
    toast(I18n.t('Back in your inbox'));
    if (state.currentFolder === SNOOZED_FOLDER) paintSnoozed();
    loadFolders();
  } catch (e) {
    toast(I18n.t('Could not bring that back') + ': ' + e.message, 6000);
  }
}

/** Swipe-to-act on mobile: drag a row left/right past a threshold to fire one
 * of {read, delete} (Settings lets the user swap which direction does which,
 * or disable this entirely). The action background is a standalone element
 * positioned over the row's live rect rather than a child of it, so it can
 * slide the whole <li> via transform without touching buildRow()'s markup —
 * the card layouts key row children off grid-template-areas, which silently
 * breaks if anything gets wrapped or reordered (bit us once already). */
function bindSwipe(li, m) {
  // A fraction of the row's own width, not a fixed number of pixels: the
  // gesture tracks the finger all the way across (it used to stop dead at
  // 140px, so on a phone the row never got further than halfway and the whole
  // thing felt like it was fighting you). It commits at 30% of the row, not
  // at the middle: having to haul a row past the halfway mark before anything
  // would take read as unresponsive in daily use, while a third of the way is
  // still far enough that a stray horizontal nudge during a scroll can't fire
  // it — and the armed colour plus the vibrate below say plainly that it has.
  const COMMIT_FRACTION = 0.3;
  const commitAt = (width) => width * COMMIT_FRACTION;
  /** Put the row back the way buildRow() left it. */
  const restore = () => { li.style.transition = ''; li.style.transform = ''; li.style.opacity = ''; li.style.position = ''; li.style.zIndex = ''; };
  let sx = 0, sy = 0, dragging = false, armed = null, bg = null, width = 0, offset = 0;
  // WHICH finger this row belongs to. e.touches[0] is the first touch on the
  // SCREEN, not the one on this row — so with two fingers on two rows, both
  // rows read the same finger and the second one mirrored the first instead of
  // following its own. Every row now tracks its own touch identifier and
  // ignores every other, which is what makes swiping two messages away at once
  // behave like two independent swipes.
  let touchId = null;
  const ownTouch = (list) => (touchId === null ? null : Array.from(list).find((t) => t.identifier === touchId) || null);

  li.addEventListener('touchstart', (e) => {
    if (!state.settings.swipeGestures || state.selectMode) return;
    if (touchId !== null) return; // a finger is already on this row; a second one on the same row is not a swipe
    const t = e.changedTouches[0]; // the touch that just landed HERE
    touchId = t.identifier;
    sx = t.clientX; sy = t.clientY; dragging = false; armed = null; offset = 0;
  }, { passive: true });

  li.addEventListener('touchmove', (e) => {
    if (!state.settings.swipeGestures || state.selectMode) return;
    const t = ownTouch(e.touches);
    if (!t) return;
    const dx = t.clientX - sx, dy = t.clientY - sy;
    if (!dragging) {
      if (Math.abs(dx) < 10 || Math.abs(dx) < Math.abs(dy)) return; // vertical scroll, not a swipe — leave it alone
      dragging = true;
      const r = li.getBoundingClientRect();
      width = r.width;
      bg = document.createElement('div');
      bg.className = 'swipe-action-bg';
      Object.assign(bg.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
      document.body.appendChild(bg);
      li.style.transition = 'none';
      li.style.position = 'relative';
      li.style.zIndex = '2';
    }
    e.preventDefault(); // committed to a horizontal drag — stop the list from also scrolling vertically
    const clamped = Math.max(-width, Math.min(width, dx));
    offset = clamped;
    li.style.transform = `translateX(${clamped}px)`;
    const swapped = !!state.settings.swipeSwapDirection;
    const dir = clamped <= -20 ? 'left' : clamped >= 20 ? 'right' : null;
    const action = dir === 'left' ? (swapped ? 'delete' : 'read') : dir === 'right' ? (swapped ? 'read' : 'delete') : null;
    const wasArmed = armed;
    armed = Math.abs(clamped) >= commitAt(width) ? action : null;
    // One short tick at the moment it crosses the commit line, so the
    // threshold is felt as well as seen — and nothing at all on the way back
    // out. Ignored on hardware/browsers without it (iOS has none).
    if (armed && !wasArmed) navigator.vibrate?.(12);
    bg.className = 'swipe-action-bg' + (action ? ` act-${action}` : '') + (armed ? ' armed' : '');
    bg.textContent = action === 'delete' ? '🗑' : action === 'read' ? (m.seen ? '✉️' : '📧') : '';
    // bg spans the row's full original width, but early in a drag only a
    // sliver of it is uncovered — a centered icon in a 300px+ wide row sat
    // far outside that sliver and wasn't visible until the swipe was nearly
    // done. Hug whichever edge is actually being revealed instead: dragging
    // left uncovers the row's right edge (it's sliding away leftward), and
    // vice versa.
    bg.style.justifyContent = dir === 'left' ? 'flex-end' : dir === 'right' ? 'flex-start' : 'center';
  }, { passive: false });

  // The system claimed the gesture (an edge back-swipe, a call arriving, the
  // finger leaving the screen area). Nothing fires — but the row must not be
  // left sitting half-open with a coloured background behind it.
  li.addEventListener('touchcancel', (e) => {
    if (!ownTouch(e.changedTouches)) return;
    touchId = null;
    if (!dragging) return;
    dragging = false;
    armed = null;
    li.style.transition = 'transform .15s ease';
    li.style.transform = '';
    bg?.remove(); bg = null;
    setTimeout(restore, 160);
  });

  li.addEventListener('touchend', (e) => {
    if (!ownTouch(e.changedTouches)) return; // some other finger came off
    touchId = null;
    if (!dragging) return;
    dragging = false;
    const action = armed;
    // A delete that can be taken back afterwards carries the row off the
    // screen in the direction it was already going — the gesture finishes
    // itself instead of snapping back a row that is about to vanish anyway.
    // Everything else returns home first: a mark-as-read row stays in the
    // list, and an irreversible delete still has a confirm dialog to put in
    // front of the user, which would look absurd over a row flung off-screen.
    const flingOff = action === 'delete' && deleteIsReversible(m);
    if (flingOff) {
      const away = Math.sign(offset) * width;
      li.style.transition = 'transform .18s ease-out, opacity .18s ease-out';
      li.style.transform = `translateX(${away}px)`;
      li.style.opacity = '0';
      // The row is removed by renderList() as soon as the delete lands, so
      // these only matter if it somehow doesn't — restore() then puts a
      // still-present row back to normal rather than leaving it invisible.
      // The delete itself waits for the row to actually leave the screen:
      // quickDelete drops it from state.messages and renderList() rebuilds the
      // whole <ul> (innerHTML = ''), so firing it now would destroy the
      // element mid-flight and the gesture would end in a row that just blinks
      // out. 180ms is the animation above; the request is that much later, and
      // nothing else waits on it.
      setTimeout(() => {
        bg?.remove(); bg = null;
        restore(); // only reachable if the delete fails and the row comes back
        quickDelete(m, { confirm: false });
      }, 180);
      return;
    }
    li.style.transition = 'transform .15s ease';
    li.style.transform = '';
    bg?.remove(); bg = null;
    setTimeout(restore, 160);
    if (action === 'delete') quickDelete(m);
    else if (action === 'read') quickToggleRead(m);
  });
}

/** Fires fn(x, y) after a ~550ms press-and-hold on a touch device; cancels on move/lift. */
function bindLongPress(el, fn) {
  let timer = null;
  el.addEventListener('touchstart', (e) => {
    const t = e.touches[0];
    timer = setTimeout(() => fn(t.clientX, t.clientY), 550);
  }, { passive: true });
  el.addEventListener('touchend', () => clearTimeout(timer));
  el.addEventListener('touchmove', () => clearTimeout(timer));
}

// Which folders count toward an account's unread badge is decided
// SERVER-side now (server/scope.js), and arrives two ways: as the
// per-account numbers in GET /api/unread, and as a `countsUnread` flag on
// each folder in GET /api/folders (used for the optimistic +/-1 nudges in
// adjustUnreadCounts). This file used to carry its own copy of that rule —
// isLabelOverlapProne/isUnifiedInboxScope/unifiedUnseenFor — which drifted
// from the server's version and made the badge and the unified message list
// disagree about the same mailbox.

/** Pull the authoritative unread counts for EVERY account and repaint.
 *
 * One request, not one per account: the old version fanned out an
 * /api/folders call per account and, on any failure, set that account's
 * count to null — silently dropping it from the total rather than keeping
 * the last known value. */
let refreshUnreadSeq = 0;
async function refreshUnread() {
  // The badge is the thing an optimistic nudge (adjustUnreadCounts) has
  // already moved, so a server total fetched around one of our own writes is
  // exactly the value that must not be allowed to overwrite it.
  if (pendingMutations) { reconcileWants |= 2; return; }
  const seq = ++refreshUnreadSeq;
  let data;
  try { data = await API.unread(); } catch { return; } // offline / logged out — keep the numbers we have rather than zeroing them
  if (seq !== refreshUnreadSeq) return; // superseded — a newer ask is already on its way back
  if (pendingMutations) { reconcileWants |= 2; return; }
  state.unreadTotal = data.total;
  for (const a of state.accounts) {
    if (Object.prototype.hasOwnProperty.call(data.accounts, a.id)) a.unseen = data.accounts[a.id];
  }
  // Older servers don't send this key at all; keeping the last numbers rather
  // than blanking every badge is the same choice the catch above makes.
  if (data.savedSearches) {
    state.savedSearchUnread = data.savedSearches;
    paintSavedSearchCounts();
  }
  renderAccounts();
}

/** Moves the saved-search badges without redrawing the sidebar — the same
 *  in-place patch reconcileFolders does for the folder rows, and for the same
 *  reason: this runs on every reconcile, and rebuilding the list would drop
 *  whatever the user was hovering or mid-long-press on. */
function paintSavedSearchCounts() {
  for (const s of state.savedSearches || []) {
    const li = $(`#folder-list li[data-path="${CSS.escape(savedSearchPath(s.id))}"]`);
    if (!li) continue;
    const n = state.savedSearchUnread?.[s.id];
    const span = li.querySelector('.f-count');
    if (n) {
      if (span) span.textContent = n;
      else li.insertAdjacentHTML('beforeend', `<span class="f-count">${n}</span>`);
    } else if (span) {
      span.remove();
    }
  }
}

async function openFolder(path, page = 1) {
  // A search stayed active across folder/account switches otherwise — every
  // subsequent folder got silently filtered by whatever was last searched
  // for, showing "no messages" anywhere that search term doesn't happen to
  // match. Navigating to a folder (this function, always) is exactly the
  // "I'm done with those search results" signal, so drop it here rather
  // than relying on every call site to remember to.
  state.query = '';
  state.searchScope = 'folder';
  state.searchScopeUsed = null;
  state.savedSearchId = null;
  const searchInput = $('#search-input');
  if (searchInput) searchInput.value = '';
  updateSearchClearBtn();
  state.currentFolder = path;
  state.page = page;
  if (state.selectMode) setSelectMode(false); else state.selected.clear();
  state.selectAnchorUid = null; // see the field's comment: uids repeat across folders
  state.openUid = null;
  $$('#folder-list li').forEach((li) => li.classList.toggle('active', li.dataset.path === path));
  closeMessage();
  closeSidebarIfMobile();
  if (path === CALENDAR_FOLDER) { Calendar.open(); return; }
  if (path === SNOOZED_FOLDER) {
    Calendar.close();
    await refreshSnoozed();
    applyScheduledChrome(true); // same chrome as the Scheduled view: nothing here is searchable or sortable
    paintSnoozed();
    return;
  }
  // Unconditional, and idempotent when the calendar was never open.
  //
  // This used to ask "am I leaving the calendar?" by reading state.currentFolder
  // — which switchAccount() has ALREADY set to 'INBOX' by the time it calls
  // here. So switching account while the calendar was open answered "no",
  // Calendar.close() never ran, `body.calendar-mode` stayed on, and the message
  // list and reading pane remained hidden with no way back. Inferring the
  // transition from mutable state was the mistake; the destination is the only
  // thing that actually decides it.
  Calendar.close();
  await loadMessages();
}

/* ---------- scheduled messages (see server/scheduledSend.js) ----------
 * Things written but not sent yet, which is why this is its own view and not
 * Drafts: a draft is something you might finish, a scheduled message is already
 * on its way, and conflating the two is how mail goes out that somebody thought
 * they had called back.
 *
 * Per PERSON, not per mailbox — so the row appears in the unified sidebar and in
 * every account's own folder list, belonging to neither. */
const SCHEDULED_FOLDER = '__SCHEDULED__';

/* ---------- the calendar (see public/js/calendar.js) ----------
 *
 * A peer of the mailbox, not a folder: opening it replaces the message list and
 * reading pane with the calendar surface. Listed here because that is where a
 * person looks for "the other things this app can show me", and next to
 * Scheduled because both are per-PERSON rather than per-mailbox.
 *
 * Deliberately NOT gated by requireAccount(): a CalDAV calendar has nothing to
 * do with mail, and somebody who uses Hmelj only for their calendar is a real
 * (if unusual) user. It is the one row that stays reachable with no mailbox at
 * all — which is also why it lives in its own <ul>, since #folder-list is
 * hidden outright in that state.
 */
const CALENDAR_FOLDER = '__CALENDAR__';

const inCalendar = () => state.currentFolder === CALENDAR_FOLDER;

function appendCalendarRow(ul) {
  const li = document.createElement('li');
  li.dataset.path = CALENDAR_FOLDER;
  if (inCalendar()) li.classList.add('active');
  li.innerHTML = '<span class="f-icon">📅</span><span>Calendar</span>';
  li.addEventListener('click', () => openFolder(CALENDAR_FOLDER));
  ul.appendChild(li);
}

/* ---------- saved searches ----------
 * A pinned QUESTION, not a folder: the query is re-run live every time the row
 * is opened, and nothing is filed anywhere. Same pseudo-path convention as the
 * Scheduled and Calendar rows (`__`-prefixed, see listedFolderFor), so every
 * "is this a real mailbox?" test in the app already answers correctly for them.
 */
const SAVED_PREFIX = '__SAVED__';
const savedSearchPath = (id) => SAVED_PREFIX + id;

function appendSavedSearchRows(ul) {
  for (const s of state.savedSearches || []) {
    const li = document.createElement('li');
    li.dataset.path = savedSearchPath(s.id);
    if (state.savedSearchId === s.id) li.classList.add('active');
    // data-no-i18n on the name for the same reason the subject cell carries it
    // (see buildRow): this is the user's own words, not part of the interface.
    // The unread count, drawn with the same `.f-count` chip the folder rows and
    // the Scheduled row use — a saved search sits among them in this list, and
    // a row that is the only one without a number reads as "nothing new" rather
    // than as "not counted". A search with NO entry (see state.savedSearchUnread)
    // gets no chip, which is how "the cache cannot answer this one" looks.
    const unseen = state.savedSearchUnread?.[s.id];
    li.innerHTML = `<span class="f-icon">🔎</span><span data-no-i18n>${esc(s.name)}</span>`
      + (unseen ? `<span class="f-count">${unseen}</span>` : '');
    li.title = s.query;
    li.addEventListener('click', () => openSavedSearch(s));
    bindLongPress(li, (x, y) => showSavedSearchMenu(s, x, y));
    li.addEventListener('contextmenu', (e) => { e.preventDefault(); showSavedSearchMenu(s, e.clientX, e.clientY); });
    ul.appendChild(li);
  }
}

/**
 * Navigate, then ask. openFolder() deliberately clears any active query — it is
 * the "done with those results" signal — so the query has to be applied AFTER
 * the navigation rather than before it, or opening a saved search would land on
 * the right folder showing everything in it.
 */
async function openSavedSearch(s) {
  const wantAccount = s.accountId || 'all';
  // A saved search for an account that has since been removed (or un-shared)
  // would otherwise switch to an id nothing answers for and leave the list
  // stuck on an error toast.
  if (s.accountId && !state.accounts.some((a) => a.id === s.accountId)) {
    toast(I18n.t('That account is no longer available — edit this saved search in Settings.'), 6000);
    return;
  }
  if (state.currentAccount !== wantAccount) await switchAccount(wantAccount);
  await openFolder(s.folder || 'INBOX');
  state.savedSearchId = s.id;
  state.query = s.query;
  state.searchScope = 'folder';
  state.searchScopeUsed = null;
  state.unreadOnly = !!s.unreadOnly;
  state.starredOnly = !!s.flaggedOnly;
  state.page = 1;
  const input = $('#search-input');
  if (input) input.value = s.query;
  updateSearchClearBtn();
  // openFolder above lit the underlying folder's row; the saved search is the
  // truer answer to "where am I", so it takes the highlight.
  $$('#folder-list li').forEach((li) => li.classList.toggle('active', li.dataset.path === savedSearchPath(s.id)));
  await loadMessages();
}

function showSavedSearchMenu(s, x, y) {
  openCtxMenu([
    { label: 'Rename', onClick: async () => {
      const name = await Dialog.prompt(I18n.t('Name for this saved search'), { value: s.name });
      if (!name || !name.trim()) return;
      s.name = name.trim();
      state.savedSearches = await API.saveSavedSearches(state.savedSearches);
      loadFolders();
    } },
    { label: 'Remove', danger: true, onClick: async () => {
      state.savedSearches = await API.saveSavedSearches((state.savedSearches || []).filter((x) => x.id !== s.id));
      // Leaving the row we are standing on would show its results under a
      // sidebar entry that no longer exists.
      if (state.savedSearchId === s.id) await openFolder('INBOX');
      loadFolders();
    } },
  ], x, y);
}

/** "Save this search" — offered under the results, next to the scope line. */
async function saveCurrentSearch() {
  if (!state.query) return;
  const name = await Dialog.prompt(I18n.t('Save this search'), { label: I18n.t('Name for this saved search'), value: state.query.slice(0, 60) });
  if (!name || !name.trim()) return;
  const entry = {
    id: String(Date.now()),
    name: name.trim(),
    query: state.query,
    // Where it is being asked right now, so reopening it asks the same
    // question rather than a differently-scoped one that happens to share text.
    accountId: state.currentAccount === 'all' ? null : state.currentAccount,
    folder: state.currentAccount === 'all' ? null : state.currentFolder,
    unreadOnly: !!state.unreadOnly,
    flaggedOnly: !!state.starredOnly,
  };
  state.savedSearches = await API.saveSavedSearches([...(state.savedSearches || []), entry]);
  await loadFolders();
  toast(I18n.t('Saved to the sidebar'));
}

function appendScheduledRow(ul) {
  const li = document.createElement('li');
  li.dataset.path = SCHEDULED_FOLDER;
  if (state.currentFolder === SCHEDULED_FOLDER) li.classList.add('active');
  li.innerHTML = '<span class="f-icon">🕗</span><span>Scheduled</span>';
  if (state.scheduledCount) li.insertAdjacentHTML('beforeend', `<span class="f-count">${state.scheduledCount}</span>`);
  li.addEventListener('click', () => openFolder(SCHEDULED_FOLDER));
  ul.appendChild(li);
}

/* ---------- the Outbox ----------
 *
 * Not a mailbox and not the server's scheduled-send queue: this is what THIS
 * DEVICE did while it could not reach the server (see public/js/outbox.js). It
 * appears only when it has something in it — an empty row that is empty every
 * day for months is chrome, not information — and it empties itself the moment
 * the connection comes back.
 *
 * Built as a peer of the Scheduled row above, deliberately: they are the two
 * places in this app where something is waiting rather than filed, and a person
 * looking for "where did my message go" should find both in the same part of
 * the sidebar. */
const OUTBOX_FOLDER = '__OUTBOX__';

function appendOutboxRow(ul) {
  if (!Outbox.count()) return;
  const li = document.createElement('li');
  li.dataset.path = OUTBOX_FOLDER;
  if (state.currentFolder === OUTBOX_FOLDER) li.classList.add('active');
  li.innerHTML = '<span class="f-icon">📤</span><span>Outbox</span>'
    + `<span class="f-count">${Outbox.count()}</span>`;
  li.addEventListener('click', () => openFolder(OUTBOX_FOLDER));
  ul.appendChild(li);
}

/** Keeps the row and its count honest without rebuilding the whole sidebar —
 *  the queue changes on every offline click, and loadFolders() is a network
 *  call that offline would not even complete. Adds the row when the first
 *  action is queued and takes it away when the last one drains; if the view
 *  itself is open, it repaints too. */
function paintOutboxBadge() {
  const ul = $('#folder-list');
  const li = $(`#folder-list li[data-path="${OUTBOX_FOLDER}"]`);
  const n = Outbox.count();
  if (!n) {
    li?.remove();
    // The queue just emptied while its own view was open: there is nothing
    // left to show, so go somewhere there is.
    if (state.currentFolder === OUTBOX_FOLDER) openFolder('INBOX');
    return;
  }
  if (!li) { if (ul) appendOutboxRow(ul); return; }
  const span = $('.f-count', li);
  if (span) span.textContent = n; else li.insertAdjacentHTML('beforeend', `<span class="f-count">${n}</span>`);
  if (state.currentFolder === OUTBOX_FOLDER) renderOutbox();
}

/** One queued action, in the user's own words. The queue stores an API call;
 *  this is the only place that turns one back into a sentence, so every string
 *  it can produce is in the catalogues (see public/i18n/en.json). */
function describeOutboxOp(op) {
  const p = op.payload || {};
  const n = p.uids?.length || 1;
  const many = (one, more) => (n === 1 ? I18n.t(one) : `${I18n.t(more)} (${n})`);
  switch (op.type) {
    case 'send': return { icon: '✉️', title: I18n.t('Send message'), detail: p.payload?.subject || I18n.t('(no subject)') };
    case 'draft': return { icon: '📝', title: I18n.t('Save draft'), detail: p.payload?.subject || I18n.t('(no subject)') };
    case 'delete': return { icon: '🗑️', title: many('Delete message', 'Delete messages'), detail: p.folder };
    case 'move': return { icon: '📁', title: many('Move message', 'Move messages'), detail: `${p.folder} → ${p.target}` };
    case 'copy': return { icon: '📄', title: many('Copy message', 'Copy messages'), detail: `${p.folder} → ${p.target}` };
    case 'refile': return {
      icon: p.box === 'junk' ? '🚫' : '🗄️',
      title: I18n.t(p.box === 'junk'
        ? (p.revert ? 'Not spam' : 'Mark as spam')
        : (p.revert ? 'Move out of Archive' : 'Move to Archive')),
      detail: p.folder,
    };
    case 'flags': {
      const has = (list, f) => (list || []).some((x) => String(x).toLowerCase() === f);
      if (has(p.add, '\\seen')) return { icon: '📖', title: many('Mark as read', 'Mark as read'), detail: p.folder };
      if (has(p.remove, '\\seen')) return { icon: '📩', title: many('Mark as unread', 'Mark as unread'), detail: p.folder };
      if (has(p.add, '\\flagged')) return { icon: '★', title: many('Star', 'Star'), detail: p.folder };
      if (has(p.remove, '\\flagged')) return { icon: '☆', title: many('Unstar', 'Unstar'), detail: p.folder };
      return { icon: '🏷️', title: I18n.t('Change flags'), detail: p.folder };
    }
    default: return { icon: '•', title: op.type, detail: p.folder || '' };
  }
}

/** The Outbox view — the message list, showing the queue instead of mail.
 *  Modelled on renderScheduled() next door, down to reusing its row classes,
 *  so the two waiting-rooms of this app look like each other rather than like
 *  two different apps. */
function renderOutbox() {
  const ul = $('#msg-list');
  applyScheduledChrome(true); // no select-all/star/refresh over a queue — same as Scheduled
  const ops = Outbox.list();
  state.messages = []; // nothing here is a mail row; see paintScheduled's own note
  state.total = ops.length;
  renderPager({ total: ops.length, page: 1, pageSize: Math.max(ops.length, 1) });
  if (!ops.length) {
    ul.innerHTML = `<li class="msg-list-loading">${esc(I18n.t('Nothing is waiting to be sent.'))}</li>`;
    return;
  }
  ul.innerHTML = '';
  for (const op of ops) {
    const d = describeOutboxOp(op);
    const li = document.createElement('li');
    li.className = 'msg-row outbox-row' + (op.state === 'failed' ? ' outbox-failed' : '');
    li.dataset.uid = String(op.id);
    li.innerHTML = `
      <span class="m-from">${d.icon} ${esc(d.title)}</span>
      <span class="m-subject" data-no-i18n>${esc(d.detail || '')}</span>
      <span class="m-date" title="${escAttr(fmtDate(op.at, { long: true }))}">${esc(fmtDate(op.at))}</span>
      ${op.lastError ? `<span class="outbox-error" data-no-i18n>${esc(op.lastError)}</span>` : ''}`;
    const menu = (x, y) => openCtxMenu(outboxMenuItems(op), x, y);
    li.addEventListener('contextmenu', (e) => { e.preventDefault(); menu(e.clientX, e.clientY); });
    li.addEventListener('click', (e) => menu(e.clientX, e.clientY));
    bindLongPress(li, menu);
    ul.appendChild(li);
  }
}

function outboxMenuItems(op) {
  const items = [];
  if (Connection.isOnline()) {
    items.push({ label: I18n.t('Try again now'), onClick: () => Outbox.retry(op.id) });
  }
  if (op.type === 'send' || op.type === 'draft') {
    // Back into the composer with everything it was written with — the same
    // door a cancelled scheduled message comes back through (compose.js).
    items.push({
      label: I18n.t('Edit'),
      onClick: async () => { await Outbox.drop(op.id); Compose.reopen(op.payload?.payload || {}); },
    });
  }
  items.push({
    label: I18n.t('Discard'),
    danger: true,
    onClick: async () => {
      if (!await Dialog.confirm(I18n.t('Discard this queued action? It will never be sent.'),
        { title: I18n.t('Discard'), okLabel: I18n.t('Discard'), danger: true })) return;
      await Outbox.drop(op.id);
    },
  });
  return items;
}

/** Repaints the sidebar badge from the queue we last fetched. Every path that
 *  fetches one goes through adoptScheduledList() and therefore through here —
 *  opening the Scheduled view used to refresh only the LIST, leaving the badge
 *  showing the pre-send count until the next 90s loadFolders() rebuilt the
 *  sidebar from state. */
function paintScheduledBadge() {
  const li = $(`#folder-list li[data-path="${SCHEDULED_FOLDER}"]`);
  if (!li) return; // sidebar not built yet — appendScheduledRow paints it from state
  const span = $('.f-count', li);
  if (state.scheduledCount) {
    if (span) span.textContent = state.scheduledCount;
    else li.insertAdjacentHTML('beforeend', `<span class="f-count">${state.scheduledCount}</span>`);
  } else span?.remove();
}

let scheduledDueTimer = null;

/** Nothing on the server pushes "the queue changed" — the send runner is a
 *  server-side timer (scheduledSend.js#TICK_MS, 30s) and the browser only ever
 *  learns by asking. So whenever we hold a queue, arm one wake-up around the
 *  moment its earliest message comes due: without it, a message that went out
 *  at 07:00 stayed on screen (and in the badge) until something unrelated
 *  happened to re-ask.
 *
 *  Due or overdue means the runner is mid-flight on it, so re-ask on a short
 *  beat until it disappears; otherwise sleep until just after its send time.
 *  Capped so a message scheduled months out still re-checks occasionally
 *  (a queue emptied from another device, a setTimeout that never survives
 *  that long anyway). */
function armScheduledDueTimer() {
  clearTimeout(scheduledDueTimer);
  scheduledDueTimer = null;
  const list = state.scheduled;
  if (!list?.length) return;
  const soonest = Math.min(...list.map((r) => r.sendAt));
  const due = soonest - Date.now();
  const delay = Math.min(due > 5000 ? due + 5000 : 20e3, 6 * 3600e3);
  scheduledDueTimer = setTimeout(() => { if (Connection.isOnline()) refreshScheduled(); }, delay);
}

/** The single place a freshly fetched queue becomes the app's state: count,
 *  list, sidebar badge and the next wake-up, together. */
function adoptScheduledList(list) {
  state.scheduledCount = list.length;
  state.scheduled = list;
  paintScheduledBadge();
  armScheduledDueTimer();
}

/** Keeps the sidebar count honest. Cheap — one small JSON array, no mail server
 *  touched — so it needs no throttle of its own. */
async function refreshScheduled() {
  let list;
  try { list = await API.scheduled(); } catch { return; } // offline: keep the count we have
  adoptScheduledList(list);
  // A previewed message that the runner has since sent (or another tab
  // cancelled) is no longer there to look at — close the pane rather than
  // leaving a message on screen that no longer exists anywhere.
  if (state.currentFolder === SCHEDULED_FOLDER && state.openUid &&
      !list.some((r) => r.id === state.openUid)) closeMessage();
  if (state.currentFolder === SCHEDULED_FOLDER) renderScheduled(list);
}

/**
 * Select mode, layout, the unread/starred/muted filters and Move-to all act on
 * mail that exists in a mailbox. None of them mean anything for a queue of
 * messages that haven't been sent, so the Scheduled view hides them rather than
 * offering controls that would silently do nothing.
 */
function applyScheduledChrome(on) {
  if (on && state.selectMode) setSelectMode(false);
  // msg-list-header included for the same reason: its three columns are sort
  // buttons, and sorting a send queue by sender isn't a thing paintScheduled
  // knows how to do, so they would click and do nothing.
  for (const id of ['btn-select-mode', 'btn-unread-only', 'btn-starred-only', 'btn-layout', 'msg-list-header']) {
    const el = $('#' + id);
    if (el) el.hidden = on;
  }
  const muted = $('#btn-show-muted');
  // Only the unified view ever shows this one, and loadFolders owns that
  // decision — hide it here, never un-hide it.
  if (muted && on) muted.hidden = true;
  // The move-to dropdown lives in the select toolbar, which is already
  // unreachable once select mode is off and its button is gone.
}

async function renderScheduled(preloaded) {
  const ul = $('#msg-list');
  applyScheduledChrome(true);
  let list = preloaded;
  if (!list) {
    try { list = await API.scheduled(); }
    catch (e) { ul.innerHTML = `<li style="padding:20px;color:var(--danger)">Error: ${esc(e.message)}</li>`; return; }
  }
  adoptScheduledList(list);
  state.messages = [];
  paintScheduled();
}

/** The synchronous half of renderScheduled: repaints from the last fetched
 *  queue with no round trip. Split out because renderList() runs on every
 *  open and close of the reading pane, and in this view it has no
 *  state.messages to draw — without a repaint from here, opening a queued
 *  message would blank the list underneath it. */
function paintScheduled() {
  const ul = $('#msg-list');
  const list = state.scheduled;
  state.total = list.length;
  renderPager({ total: list.length, page: 1, pageSize: Math.max(list.length, 1) });
  if (!list.length) {
    ul.innerHTML = `<li class="msg-list-loading">${esc(I18n.t('Nothing scheduled yet.'))}</li>`;
    return;
  }
  ul.innerHTML = '';
  for (const item of list) ul.appendChild(scheduledRow(item));
}

/** Which account a queued message will go out through. Resolved here the same
 *  way the server resolves it at send time (smtpClient.js#accountForIdentity):
 *  the identity's own account, falling back to the first enabled one when the
 *  identity doesn't name one. Kept client-side so the queue listing stays the
 *  one cheap JSON array it has always been. */
function scheduledAccount(item) {
  const ident = (state.identities || []).find((i) => i.id === item.identityId);
  if (ident?.accountId) {
    const a = state.accounts.find((x) => x.id === ident.accountId);
    if (a) return a;
  }
  return state.accounts.find((a) => !a.disabled) || null;
}

function scheduledRow(item) {
  const li = document.createElement('li');
  li.className = 'msg-row' + (state.openUid === item.id ? ' selected' : '');
  li.dataset.uid = item.id;
  // "Due in the past" means the runner is working on it (or is about to) — not
  // that anything is wrong, unless it has been failing, which lastError shows.
  const late = item.sendAt < Date.now() - 60e3;
  const unresolved = item.state === 'unresolved';
  const when = unresolved ? I18n.t('May have been sent')
    : late ? I18n.t('Sending…')
    : fmtDate(item.sendAt, { long: true });
  // .m-date, not a column of its own: that is the cell all five list layouts
  // already reserve for a time — the Date column in the table layout, the
  // bottom-right corner of the card in the other four. .m-when only adds the
  // status colouring on top.
  const status = `<span class="m-date m-when${late || unresolved ? ' late' : ''}" title="${escAttr(when)}">${esc(when)}</span>`;
  const a = scheduledAccount(item);
  const chip = a
    ? `<span class="acct-chip acct-chip-static" style="--chip:${escAttr(a.color)}" title="${escAttr(I18n.t('Sends from') + ': ' + a.label)}">${esc(acctInitials(a.label))}</span>`
    : '';
  li.innerHTML = `
    ${chip}<span class="m-from">${esc(I18n.t('To') + ': ' + (item.to || '—'))}</span>
    <span class="m-subject">${esc(item.subject || '(no subject)')}</span>
    ${item.attachmentCount ? '<span class="m-attach" title="Has attachment">📎</span>' : ''}
    ${status}`;
  if (item.lastError) li.title = `${I18n.t('attempt')} ${item.attempts}: ${item.lastError}`;
  // Same gesture split as a real message row (buildRow): open it on a plain
  // click, actions on right-click / long-press.
  li.addEventListener('click', () => openScheduledPreview(item));
  li.addEventListener('contextmenu', (e) => { e.preventDefault(); openScheduled(item, e.clientX, e.clientY); });
  bindLongPress(li, (x, y) => openScheduled(item, x, y));
  return li;
}

/**
 * Reads a queued message in the reading pane before it goes out.
 *
 * Always the pane, whatever readingPane is set to: the 'window' and 'off' modes
 * both address a message by folder + UID through message.html, and a message
 * that has not been sent has neither.
 */
async function openScheduledPreview(item) {
  navPush(); // hardware back closes the preview instead of exiting
  state.openUid = item.id;
  paintScheduled();
  const view = $('#message-view');
  $('#empty-state').hidden = true;
  view.hidden = false;
  if (isMobileViewport()) {
    mobileListScroll = $('#msg-list').scrollTop;
    $('#content').classList.add('mobile-show-message');
  }
  view.classList.add('mv-placeholder');
  view.innerHTML = `<p style="color:var(--text-dim)">${esc(I18n.t('Loading message…'))}</p>`;
  let data;
  try { data = await API.scheduledItem(item.id); }
  catch (e) {
    view.innerHTML = `<p style="color:var(--danger)">Error: ${esc(e.message)}</p>`;
    return;
  }
  // The runner may have sent it, or another tab cancelled it, between the click
  // and the response landing — don't paint over whatever is open now.
  if (state.openUid !== item.id) return;
  view.classList.remove('mv-placeholder');
  renderScheduledPreview(view, data, item);
}

/** Deliberately not renderMessage(): there is no star, no read/unread, no
 *  reply, no move and no headers to show — none of that exists until the
 *  message is on a server. What it shares is the .mv-* chrome and the sandboxed
 *  MessageFrame, wrapped in the same .mv-card that lets a theme change
 *  rebuild the iframe in place (see refreshOpenMessageTheme). */
function renderScheduledPreview(view, data, item) {
  const fontFamily = migrateFontValue(state.settings.messageFont);
  const fontSize = state.settings.messageFontSize || 15;
  const fontOverride = !!state.settings.messageFontOverride;
  const a = scheduledAccount(item);
  const ident = (state.identities || []).find((i) => i.id === data.identityId);
  const late = data.sendAt < Date.now() - 60e3;
  const unresolved = data.state === 'unresolved';
  const prio = data.priority && data.priority !== 'normal'
    ? `<span class="${data.priority === 'high' ? 'mv-priority-high' : ''}" title="Priority">${data.priority === 'high' ? '❗ High priority' : '⬇ Low priority'}</span>` : '';
  const fromLine = ident?.name && ident?.email
    ? `${esc(ident.name)} <span class="mv-from-addr">&lt;${esc(ident.email)}&gt;</span>`
    : esc(ident?.email || a?.label || '');
  const toLine = esc(I18n.t('To') + ': ' + (data.to || '—')) +
    (data.cc ? ' · Cc: ' + esc(data.cc) : '') +
    (data.bcc ? ' · Bcc: ' + esc(data.bcc) : '');
  const due = unresolved ? I18n.t('May have been sent')
    : late ? I18n.t('Sending…')
    : `${I18n.t('Will send')} ${fmtDate(data.sendAt, { long: true })}`;
  let banner = `<div class="mv-banner">🕗 ${esc(due)}${a ? ' — ' + esc(a.label) : ''}</div>`;
  if (data.lastError) {
    banner += `<div class="mv-banner">⚠ ${esc(`${I18n.t('attempt')} ${data.attempts}: ${data.lastError}`)}</div>`;
  }

  // Wrapped in the same .mv-card the real message renderer produces, so a
  // theme change rebuilds this frame too (see refreshOpenMessageTheme).
  view.innerHTML = `
    <article class="mv-card">
    <div class="mv-header-card">
      <div class="mv-header-top">
        <h1 class="mv-subject">${esc(data.subject || '(no subject)')}</h1>
        <div class="mv-header-icons">
          <button class="icon-btn" id="mv-more" title="More">⋯</button>
        </div>
      </div>
      <div class="mv-from-line">${fromLine} ${prio}</div>
      <div class="mv-to-line">${toLine}</div>
      ${banner}
    </div>
    <div class="mv-body mv-body-slot"></div>
    ${data.attachments.length ? `<div class="mv-attachments">${data.attachments.map((f) =>
      // A span, not the .attach-chip anchor a real message uses: the bytes are
      // in the queue file, not behind a URL, so there is nothing to link to.
      `<span class="attach-chip attach-chip-static">📎 ${esc(f.filename)} <small>(${Math.round(f.size / 1024)} KB)</small></span>`).join('')}</div>` : ''}
    </article>`;

  const card = $('.mv-card', view);
  card.__frameOpts = { html: data.html || undefined, text: data.text, fontFamily, fontSize, fontOverride, fonts: state.customFonts, expandQuote: true };
  $('.mv-body-slot', view).appendChild(MessageFrame.create({ ...card.__frameOpts, ...themeColorsForFrame() }));
  $('#mv-more', view).addEventListener('click', (e) => {
    e.stopPropagation();
    const r = e.currentTarget.getBoundingClientRect();
    openScheduled(item, r.right - 180, r.bottom + 4);
  });
}

/**
 * The actions on a queued message — right-click, long-press, or the ⋯ button in
 * the preview. A plain click reads it instead (openScheduledPreview), matching
 * every other list in the app.
 */
async function openScheduled(item, x, y) {
  const unresolved = item.state === 'unresolved';
  const items = [];
  items.push({ label: `👁 ${I18n.t('Open')}`, onClick: () => openScheduledPreview(item) });
  // Moving the time never reopens the composer: re-sending a body through it to
  // change one timestamp risks the message coming back subtly different from
  // the one that was approved.
  if (!unresolved) items.push({ label: '🕗 Reschedule…', onClick: () => rescheduleScheduled(item, x, y) });
  items.push({ label: '✏️ Cancel and edit', onClick: () => cancelScheduled(item, unresolved) });
  if (item.lastError) {
    items.push({ label: `⚠ ${I18n.t('attempt')} ${item.attempts}: ${item.lastError}`, disabled: true });
  }
  if (unresolved) {
    items.push({ label: `⚠ ${I18n.t('May have been sent')}`, disabled: true });
  }
  openCtxMenu(items, x, y);
}

async function rescheduleScheduled(item, x, y) {
  // Seeded with the time already set: the menu heads with it and the date picker
  // opens on it, so "reschedule" starts from what this message is actually set
  // to rather than from a generic suggestion.
  const at = await Compose.pickSendTime(x, y, { current: item.sendAt });
  if (!at) return;
  try { await API.rescheduleScheduled(item.id, at); }
  catch (e) { return toast('Could not reschedule: ' + e.message, 5000); }
  await refreshScheduled();
  // The preview's banner quotes the old time — repaint it from the refreshed
  // record rather than leaving it contradicting the row right next to it.
  if (state.openUid === item.id) {
    const updated = state.scheduled.find((s) => s.id === item.id);
    if (updated) openScheduledPreview(updated); else closeMessage();
  }
  toast(`${I18n.t('Will send')} ${fmtDate(at, { long: true })}`, 4000);
}

/** Takes it back out of the queue and hands it to the composer. Also the
 *  "send it again" path for an interrupted message — one mechanism, so a
 *  cancelled message is never dropped on the floor. */
async function cancelScheduled(item, unresolved) {
  if (unresolved && !await Dialog.confirm(
    I18n.t('Hmelj restarted while this message was being sent, so there is no way to tell whether it went out. Check your Sent folder before sending it again.'),
    { title: I18n.t('May have been sent'), okLabel: I18n.t('Cancel and edit') })) return;
  let payload;
  try { ({ payload } = await API.cancelScheduled(item.id)); }
  catch (e) { return toast('Could not cancel: ' + e.message, 5000); }
  if (state.openUid === item.id) closeMessage(); // it isn't there to preview any more
  refreshScheduled();
  Compose.reopen(payload);
  toast(I18n.t('Taken out of the queue — send or reschedule it from here'), 5000);
}

/* ---------- message list ---------- */

/** The identity of what the list is currently showing. Anything in here changing
 * means the user navigated somewhere new; everything else that calls
 * loadMessages() (the refresh button, a filter run, a folder resync) is a
 * repaint of the SAME view. */
function messageViewKey() {
  return [state.currentAccount, state.currentFolder, state.page, state.query, state.unreadOnly ? 1 : 0, state.starredOnly ? 1 : 0]
    .join(String.fromCharCode(0)); // NUL — a folder path can contain any printable separator
}
let lastMessageViewKey = null;

/**
 * Which mailboxes the view currently on screen covers, as {account, folder}
 * pairs — what Offline.buildList needs to answer a listing from saved headers.
 *
 * Only this file can work it out: "All inboxes" means one folder per account,
 * and which folder that is (INBOX, or each account's own Sent) is a property of
 * the accounts, not of the cache.
 */
function offlineScopes() {
  if (state.currentAccount !== 'all') {
    return [{ account: state.currentAccount, folder: state.currentFolder }];
  }
  const sent = state.currentFolder === '__SENT__';
  return activeAccounts()
    .map((a) => ({ account: a.id, folder: sent ? a.sentFolder : 'INBOX' }))
    .filter((s) => s.folder);
}

/** The list container is reused across loads, so its scroll position survives
 * a page change: tapping "›" after scrolling down left the reader parked
 * halfway down a page they had never seen, which on a phone (where the pager
 * is at the bottom of a full-screen list) looks like the tap did nothing.
 * Navigating starts at the top; a plain refresh of the same view deliberately
 * does NOT move, so nothing yanks the list out from under someone reading it.
 * mobileListScroll goes with it — it's the position closeMessage() restores,
 * and it belongs to the page that just went away. */
function scrollListToTopOnNavigation() {
  const key = messageViewKey();
  if (key === lastMessageViewKey) return;
  lastMessageViewKey = key;
  mobileListScroll = 0;
  const ul = $('#msg-list');
  if (ul) ul.scrollTop = 0;
}

function esc(s) { const d = document.createElement('div'); d.textContent = s ?? ''; return d.innerHTML; }
function escAttr(s) { return esc(s).replace(/"/g, '&quot;'); }

// Bumped on every loadMessages() call, captured locally as `seq` — a slow call (a
// live IMAP search across every account can take many seconds, see API.unified's own
// timing) whose response lands AFTER a newer call has already started is stale by the
// time it resolves and must never overwrite what that newer call already painted, or
// display briefly "corrects itself" backwards to older results a moment later.
let loadMessagesSeq = 0;

async function loadMessages() {
  // The calendar owns the whole content area and fetches its own data. Checked
  // before the no-mailbox guard below, deliberately: a calendar does not need a
  // mail account, and returning early there would leave the grid blank for
  // somebody who has only ever added a CalDAV server.
  if (inCalendar()) return;
  // And if we are NOT in it but it is still on screen, something reached the
  // mail list without going through openFolder. Painting a list into a pane
  // `body.calendar-mode` is hiding produces a window that looks frozen, so the
  // last word on which view is showing belongs here, next to the code that
  // fills it.
  if (Calendar.isOpen()) Calendar.close();
  // No mailbox: there is nothing to list, and asking would only produce
  // "No mail account selected" from the server. The empty state stays put.
  if (hasNoAccounts()) { renderNoAccountState(); return; }
  const seq = ++loadMessagesSeq;
  const ul = $('#msg-list');
  // Don't clear+repaint "Loading…" immediately — instantly wiping the previous
  // folder's rows on every switch produced a jarring white blink even for
  // responses that came back in well under a second. Only show it once the
  // request has actually been in flight for a bit, and only if nothing newer
  // has superseded this call by then.
  const loadingTimer = setTimeout(() => {
    if (seq === loadMessagesSeq) ul.innerHTML = '<li class="msg-list-loading">Loading…</li>';
  }, 150);
  if (state.currentFolder === SCHEDULED_FOLDER) {
    clearTimeout(loadingTimer);
    return renderScheduled();
  }
  // Same shape as Scheduled above: a local queue, not a mailbox, and every one
  // of its rows is already in memory — there is nothing to fetch.
  if (state.currentFolder === OUTBOX_FOLDER) {
    clearTimeout(loadingTimer);
    return renderOutbox();
  }
  applyScheduledChrome(false); // leaving the queue view — restore the real toolbar
  let data;
  try {
    if (state.currentAccount === 'all') {
      const box = state.currentFolder === '__SENT__' ? 'sent' : 'inbox';
      data = await API.unified(box, { page: state.page, q: state.query, unread: state.unreadOnly, flagged: state.starredOnly, hideMuted: !state.showMuted, scope: searchScopeParam() });
    } else {
      data = await API.messages(state.currentFolder, { page: state.page, q: state.query, unread: state.unreadOnly, flagged: state.starredOnly, scope: searchScopeParam() });
    }
  } catch (e) {
    // api.js has already tried the offline cache for this exact request; an
    // `.offline` error here means it had never seen this particular view — page
    // four of a folder, or a search typed with no connection. Rather than an
    // error where a list should be, build one out of the message headers this
    // device HAS saved, and label it (renderList's local-results note) so it is
    // never mistaken for the server's answer.
    if (e?.offline) {
      const local = await Offline.buildList({
        scopes: offlineScopes(), page: state.page, pageSize: state.settings.messagesPerPage || 50,
        q: state.query, unread: state.unreadOnly, flagged: state.starredOnly,
      });
      if (local && seq === loadMessagesSeq) { clearTimeout(loadingTimer); data = local; }
    }
    if (!data) {
      clearTimeout(loadingTimer);
      if (seq !== loadMessagesSeq) return; // superseded — a newer call already owns the view
      ul.innerHTML = `<li style="padding:20px;color:var(--danger)">Error: ${esc(e.message)}</li>`;
      return;
    }
  }
  clearTimeout(loadingTimer);
  if (seq !== loadMessagesSeq) return; // superseded while this fetch was in flight — discard, don't paint stale data over newer
  state.messages = data.messages;
  state.total = data.total;
  state.listLocal = !!data._local;
  state.searchScopeUsed = data.scope || null;
  // Before the first paint, so a row's ✎ is there from the start rather than
  // appearing a moment later — it is one small request against a table with one
  // entry per open draft.
  await refreshDraftState();
  if (seq !== loadMessagesSeq) return;
  renderList();
  renderPager(data);
  scrollListToTopOnNavigation();
  if (state.settings.runFiltersOnLoad && state.currentAccount !== 'all' && state.currentFolder === 'INBOX' && state.page === 1) {
    API.runFilters('INBOX').then((r) => { if (r.matched) { toast(`Filters applied to ${r.matched} message(s)`); loadMessages(); loadFolders(); } }).catch(() => {});
  }
}


/* ---------- background sync status ----------
 * The server polls IMAP on its own now (server/sync.js); this just asks it
 * "did anything change since I last checked" every ~15s and, if so, quietly
 * reloads whichever folder/unified view is currently open — so new mail
 * shows up without the user having to hit refresh. Short-poll rather than a
 * persistent connection: simplest to reason about behind a reverse proxy,
 * and trivially recovers from a laptop sleeping or a phone switching networks.
 */
const syncStatus = {}; // accountId -> {lastSyncedAt, syncing, lastError}

// #btn-refresh's spinning state has two independent sources — a manual click and
// the background poll noticing a sync in progress — either of which should keep it
// spinning; used to be a manual .spinning toggle plus a wholly separate #sync-badge
// icon for the background case, which visually implied two different things were
// happening. Tracked as two booleans + one setter so the click handler's own
// try/finally and pollSyncStatus() can't stomp on each other's state.
let manualRefreshInFlight = false;
let backgroundSyncActive = false;
function updateRefreshSpin() {
  const btn = $('#btn-refresh');
  if (btn) btn.classList.toggle('spinning', manualRefreshInFlight || backgroundSyncActive);
}

function watchedAccountIds() {
  return state.currentAccount === 'all' ? state.accounts.map((a) => a.id) : [state.currentAccount];
}

/* ---------- reconcile scheduling ----------
 *
 * A reconcile is a READ of server state, and the server cannot possibly know
 * about a write of ours that hasn't finished yet. Marking six messages
 * read/unread in a couple of seconds made that visible: every one of those
 * POSTs broadcasts an SSE event back to this very tab (server/events.js
 * doesn't exclude the originator), each event ran a reconcile, and any
 * reconcile that landed while a SLOW write was still in flight — Gmail
 * routinely takes 1.5-2s for a single STORE — painted that message's
 * pre-change state back over the optimistically-flipped row. When the slow
 * write finally landed, its own event flipped the row forward again. Rows
 * visibly ping-ponged.
 *
 * Three things fix it, and all three are needed:
 *   - pendingMutations: never READ while one of our own WRITES is in flight;
 *     remember that a reconcile is owed and run it once they've all settled.
 *   - the seq guards inside each reconcile below: parallel fetches can resolve
 *     out of order (four /api/unified/inbox calls were in flight inside 80ms),
 *     and the LAST response to arrive is not necessarily the freshest ask.
 *   - the debounce + `wants` bitmask: a burst of clicks, and the duplicate
 *     request each click used to make (the SSE handler and quickToggleRead
 *     both asked for the same folder refresh), collapse into one pass. */
let pendingMutations = 0;
let reconcileWants = 0; // bitmask: 1 = message list, 2 = folders/badges
let reconcileTimer = null;
const RECONCILE_DEBOUNCE_MS = 150;
const MUTATION_MAX_MS = 30000;

/** Wraps one in-flight mutation (anything that changes server-side mail state)
 * so the reconciles above can stay out of its way. Transparent: the caller
 * gets the same resolution/rejection it would have without this. */
function trackMutation(p) {
  pendingMutations++;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    if (--pendingMutations) return;      // others still running — the last one out flushes
    if (reconcileWants) armReconcile();  // something asked while we were busy; now it can be answered
  };
  // Safety valve. api.js sets no request timeout at all, so a fetch that never
  // settles (a proxy holding the socket open, a phone suspended mid-request)
  // would otherwise leave pendingMutations above zero forever and freeze every
  // future refresh — a far worse failure than the flicker this whole mechanism
  // exists to prevent. Well past any real IMAP write; the slowest measured here
  // was ~2s.
  const bail = setTimeout(release, MUTATION_MAX_MS);
  return Promise.resolve(p).finally(() => { clearTimeout(bail); release(); });
}

function armReconcile() {
  clearTimeout(reconcileTimer);
  reconcileTimer = setTimeout(() => {
    reconcileTimer = null;
    const want = reconcileWants;
    reconcileWants = 0;
    if (want & 1) reconcileMessages();
    if (want & 2) reconcileFolders();
  }, RECONCILE_DEBOUNCE_MS);
}

/** "Something changed, refresh the view" — the coalescing entry point every
 * event-driven caller should use instead of calling the two reconcilers
 * directly. `what` is the same bitmask as reconcileWants. */
function scheduleReconcile(what = 3) {
  reconcileWants |= what;
  if (pendingMutations) return; // trackMutation flushes once the last write settles
  armReconcile();
}

/** Silent counterpart to loadMessages(): fetches fresh data for the
 * currently-open view, but skips the DOM entirely if nothing actually
 * changed, and patches in place (patchList) rather than wiping/rebuilding
 * when something did — avoids the visible "blink" on every background poll.
 *
 * Bails rather than painting whenever it can't prove its data is still the
 * freshest thing available — see the reconcile-scheduling comment above. */
let reconcileMessagesSeq = 0;

/** `is:starred` is answered by a LIVE sweep of every folder in scope
 * (server/index.js's starredLive), not from the cache — seconds of work whose cost
 * scales with how many folders the account has. Repeating it on every background
 * event would mean re-sweeping the whole mailbox each time a star is toggled in the
 * results. Kept in sync by hand with searchQuery.js#STARRED_TERM_RE — the client only
 * needs to recognize the term, never to parse it. */
function queryIsLiveSweep(q) { return /(^|\s)is:(starred|flagged)(?=\s|$)/i.test(q || ''); }

async function reconcileMessages() {
  // The Scheduled view isn't a mailbox — it holds no state.messages, so letting
  // a reconcile run here would fetch a folder the server has never heard of and
  // then patch the list down to the empty array it compared against.
  if (state.currentFolder === SCHEDULED_FOLDER) return refreshScheduled();
  // And the Outbox is not on the server at all — nothing there could be
  // reconciled against it.
  if (state.currentFolder === OUTBOX_FOLDER) return renderOutbox();
  // Same reasoning: the calendar is not backed by state.messages, and a
  // reconcile here would fetch a folder the server has never heard of.
  if (inCalendar()) return Calendar.refresh();
  if (pendingMutations) { reconcileWants |= 1; return; }
  // Silent refreshes sit a live sweep out. Everything explicit — the refresh button,
  // re-running the search, navigating anywhere — still goes through loadMessages().
  // An escalated search ("Search everywhere") is the same case for a second reason:
  // this call deliberately omits searchScopeParam(), so re-running it would answer
  // the NARROW question and quietly patch the whole-account results back down to
  // the cached folder ones — under a footer still saying the account was searched.
  if (queryIsLiveSweep(state.query) || state.searchScope === 'account') return;
  const seq = ++reconcileMessagesSeq;
  const load = loadMessagesSeq; // a full (re)load owns the view outright; never paint over one
  let data;
  try {
    if (state.currentAccount === 'all') {
      const box = state.currentFolder === '__SENT__' ? 'sent' : 'inbox';
      data = await API.unified(box, { page: state.page, q: state.query, unread: state.unreadOnly, flagged: state.starredOnly, hideMuted: !state.showMuted });
    } else {
      data = await API.messages(state.currentFolder, { page: state.page, q: state.query, unread: state.unreadOnly, flagged: state.starredOnly });
    }
  } catch {
    return; // offline / logged out — next poll retries
  }
  if (seq !== reconcileMessagesSeq || load !== loadMessagesSeq) return; // superseded while in flight
  if (pendingMutations) { reconcileWants |= 1; return; } // a write started while we were fetching — this answer predates it
  if (data.total === state.total && messagesSignature(data.messages) === messagesSignature(state.messages)) return;
  state.messages = data.messages;
  state.total = data.total;
  patchList();
  renderPager(data);
}

/** Silent counterpart to loadFolders(): patches unread-count badges in place
 * instead of clearing and rebuilding the whole folder tree, unless the
 * folder structure itself changed (rare — falls back to a full rebuild).
 * Same in-flight/superseded rules as reconcileMessages above. */
let reconcileFoldersSeq = 0;
async function reconcileFolders() {
  if (pendingMutations) { reconcileWants |= 2; return; }
  if (state.currentAccount === 'all') { refreshUnread(); return; }
  const seq = ++reconcileFoldersSeq;
  let folders;
  try { folders = await API.folders(); } catch { return; }
  if (seq !== reconcileFoldersSeq) return; // superseded while in flight
  if (pendingMutations) { reconcileWants |= 2; return; }
  const sameShape = folders.length === state.folders.length && folders.every((f, i) => f.path === state.folders[i].path);
  if (!sameShape) return loadFolders();
  state.folders = folders;
  refreshUnread();
  renderAccounts();
  for (const li of $$('#folder-list li')) {
    const f = folders.find((x) => x.path === li.dataset.path);
    if (!f) continue;
    const span = li.querySelector('.f-count');
    if (f.unseen) {
      if (span) span.textContent = f.unseen;
      else li.insertAdjacentHTML('beforeend', `<span class="f-count">${f.unseen}</span>`);
    } else if (span) {
      span.remove();
    }
  }
}

async function pollSyncStatus() {
  let list;
  try {
    list = await API.syncStatus();
  } catch {
    return; // offline / logged out — next tick retries
  }
  const watched = watchedAccountIds();
  let changed = false;
  let anySyncing = false;
  const justSynced = []; // accountIds whose sync cycle just completed — notification check, regardless of what's currently open
  for (const s of list) {
    const prev = syncStatus[s.accountId];
    if (s.syncing) anySyncing = true;
    // Only reload once an account's sync CYCLE has actually finished
    // (s.syncing false), not on every individual folder completion within
    // it — a big first backfill (e.g. a large Gmail account) touches many
    // folders over the better part of a minute, and reloading the
    // interactive view on every single one of those never lets a reload
    // finish before the next one starts.
    const cycleJustFinished = prev && prev.lastSyncedAt && prev.lastSyncedAt !== s.lastSyncedAt && !s.syncing;
    if (watched.includes(s.accountId) && cycleJustFinished) changed = true;
    if (cycleJustFinished) justSynced.push(s.accountId);
    syncStatus[s.accountId] = s;
  }
  backgroundSyncActive = anySyncing;
  updateRefreshSpin();
  if (changed) scheduleReconcile();
  if (justSynced.length) checkNewMailNotifications(justSynced);
}

/* ---------- notifications ----------
 * Two layers, both gated on the same `desktopNotifications` setting +
 * Notification permission:
 *  - Web Push (server/push.js + sw.js's 'push' listener) — real background
 *    delivery, works even with Hmelj fully closed. This is now the primary
 *    path on any device where the browser supports it (pushActive below).
 *  - This foreground poll-driven notifier — the ONLY thing this app had
 *    before push existed, kept as a fallback for browsers without Push API
 *    support (or where subscribing failed for some other reason). Gated off
 *    below once a device has an active push subscription, so a push-capable
 *    device never gets the same message notified twice. */
let pushActive = false; // this device has a live push subscription — set once at boot, see detectPushActive()
const lastUnseenByAccount = {}; // accountId -> unseen count as of the last check
const notifiedUids = new Map(); // accountId -> Set(uid) already popped, so a steady unseen count doesn't re-notify every poll

async function checkNewMailNotifications(accountIds) {
  if (pushActive) return; // push already covers this device — avoid double-notifying
  if (!state.settings?.desktopNotifications) return;
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  // One request covering every account, from the same authoritative source
  // the badges use — this used to fetch each account's whole folder list and
  // re-sum it with the client's own (drifting) copy of the scope rule.
  let counts;
  try { counts = (await API.unread()).accounts; } catch { return; }
  for (const id of accountIds) {
    const a = state.accounts.find((x) => x.id === id);
    if (!a || a.disabled) continue;
    // Notification scheduler (see settings.js's Scheduler tab, server/schedule.js) —
    // best-effort client-side mirror of the authoritative server-side gate in
    // server/sync.js. Only ever checks the account-level schedule against 'INBOX',
    // matching this whole function's own pre-existing INBOX-only scope (it doesn't
    // support per-folder notifications at all — a limitation this feature doesn't
    // widen). Real Web Push delivery is fully covered server-side regardless; this
    // path only ever runs on a device with no active push subscription at all
    // (the pushActive check above).
    // A temporary Mute on the INBOX silences this fallback too — the server
    // already refuses to push for it (sync.js#notifyNewMail), and a device
    // without push would otherwise be the one place a muted folder still pops
    // up notifications.
    if (ScheduleUtil.folderMutedUntil(a, 'INBOX')) continue;
    const effective = ScheduleUtil.resolveEffectiveSchedule(a, 'INBOX');
    if (effective) {
      const workFreeDateSet = await ScheduleUtil.ensureHolidaysLoaded();
      if (ScheduleUtil.isMutedNow(effective, { workFreeDateSet })) continue;
    }
    const unseen = counts[id];
    if (unseen === undefined) continue;
    const prevUnseen = lastUnseenByAccount[id];
    lastUnseenByAccount[id] = unseen;
    // First observation of this account (prevUnseen undefined) just seeds
    // the baseline — otherwise every account would pop a notification for
    // its entire existing unread backlog the moment notifications get
    // turned on. Only a genuine increase since the last check counts.
    if (prevUnseen === undefined || unseen <= prevUnseen) continue;
    let data;
    try { data = await API.messages('INBOX', { page: 1, unread: true }, id); } catch { continue; }
    const notified = notifiedUids.get(id) || new Set();
    const fresh = data.messages.filter((m) => !notified.has(m.uid)).slice(0, 3);
    for (const m of fresh) { notified.add(m.uid); showMailNotification(a, m); }
    notifiedUids.set(id, notified);
  }
}

async function showMailNotification(account, m) {
  const from = m.from?.name || m.from?.address || '';
  const title = from ? `${from} — ${account.label}` : account.label;
  const body = m.subject || '(no subject)';
  const tag = `hmelj-${account.id}-${m.uid}`;
  // Prefer the service worker's own notification: ONLY a persistent
  // notification may carry action buttons, so this is the only way this
  // fallback notifier can offer the same "Mark as read"/"Delete" a real push
  // does — and its clicks land in the very same sw.js#notificationclick
  // handler, so the two are identical to use. Gated on there being an active
  // service worker controlling this page: navigator.serviceWorker.ready never
  // resolves when there is no registration at all (a plain-http LAN origin —
  // no secure context, no service worker, which is exactly where this
  // fallback notifier earns its keep), and awaiting it there would swallow the
  // notification entirely.
  try {
    if (navigator.serviceWorker?.controller) {
      const reg = await navigator.serviceWorker.ready;
      await reg.showNotification(title, {
        body,
        icon: '/icons/icon-192.png',
        tag,
        data: { accountId: account.id, folder: 'INBOX', uid: m.uid },
        actions: [
          { action: 'read', title: I18n.t('Mark as read') },
          { action: 'delete', title: I18n.t('Delete') },
        ],
      });
      return;
    }
  } catch { /* fall through to the plain page notification below */ }
  let n;
  try {
    n = new Notification(title, { body, icon: '/icons/icon-192.png', tag });
  } catch { return; }
  n.addEventListener('click', async () => {
    window.focus();
    if (state.currentAccount !== account.id) await switchAccount(account.id);
    openMessage(m);
    n.close();
  });
}

let syncPollTimer = null;
function startSyncStatusPolling() {
  if (syncPollTimer) return; // already running — offline/online can call this on top of boot's own call
  pollSyncStatus();
  syncPollTimer = setInterval(pollSyncStatus, 15 * 1000);
}
function stopSyncStatusPolling() {
  clearInterval(syncPollTimer);
  syncPollTimer = null;
}

/* ---------- offline/online handling ----------
 * "If offline, do nothing; when back online, refresh and notify": Web Push
 * itself needs no help here — the OS/push service queues a notification
 * and delivers it automatically once THIS device reconnects, regardless of
 * whether this page is even open. What actually needs
 * handling is this page's own foreground polling: a plain setInterval kept
 * firing (and failing) every 15s for no benefit while offline, and without
 * an explicit catch-up, the open view would otherwise sit stale until the
 * background poller's own next scheduled tick (up to config.syncIntervalMs,
 * default 2 minutes) after reconnecting instead of updating right away. */
function updateConnIndicator(online) {
  const el = $('#conn-status');
  if (!el) return;
  el.classList.toggle('ok', online);
  el.classList.toggle('offline', !online);
  if (!online) el.title = I18n.t('No connection to the Hmelj server');
}

/* The transitions themselves are driven by js/connection.js, which decides
 * reachability from what actually happens to requests rather than from
 * navigator.onLine alone (a device with "a network" but no route to a
 * self-hosted server is offline as far as Hmelj is concerned). This is just
 * what the mail UI does on each edge. */
Connection.onChange(async (online) => {
  updateConnIndicator(online);
  updateOfflineBanner();
  if (!online) {
    // Nothing here can succeed until the server is back, and a poll that
    // fails every 15s is just noise — connection.js is already probing.
    stopSyncStatusPolling();
    disconnectEvents();
    // What CAN still be done is disabled rather than left to fail one toast at
    // a time (see the function's own note).
    applyOfflineAffordances();
    // Re-asked on every drop, not just at boot: a session that started with an
    // empty cache has usually filled it by the time the connection goes, and
    // the banner would otherwise still be apologising for mail that is right
    // there on the screen.
    Offline.envelopes().then((e) => {
      state.offlineHasCache = e.length > 0;
      updateOfflineBanner();
    });
    return;
  }
  applyOfflineAffordances();
  startSyncStatusPolling(); // no-op if it was never actually stopped
  connectEvents();
  scheduleReconnectRefresh();
});

/* ---------- coming back ----------
 *
 * Reconnecting is expensive: it drains the outbox, asks every account's server
 * to go and talk to IMAP, then reloads the list, the folders and the counts.
 * Doing that once, when the connection returns, is right. Doing it every time
 * `reachable` flips is what turned a flaky link into a page that refreshed
 * itself every few seconds.
 *
 * And it flips easily, for a reason that is not a bug: a self-hosted server
 * that is merely BUSY still answers the cheap /api/session probe while timing
 * out the calls that need IMAP. connection.js is right to report that as up;
 * this is the part that has to be sceptical about it.
 *
 * Two guards, and both are needed. The connection must still be up after a
 * settling delay — a flip that lasted two seconds was never a reconnection —
 * and two full refreshes can never happen close together, however many times
 * it flips in between.
 */
const RECONNECT_SETTLE_MS = 2500;
const RECONNECT_MIN_GAP_MS = 30000;
let reconnectTimer = null;
let reconnectRunning = false;
let lastReconnectAt = 0;

function scheduleReconnectRefresh() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(runReconnectRefresh, RECONNECT_SETTLE_MS);
}

async function runReconnectRefresh() {
  reconnectTimer = null;
  if (!Connection.isOnline() || reconnectRunning) return; // gone again, or already doing it
  const since = Date.now() - lastReconnectAt;
  if (since < RECONNECT_MIN_GAP_MS) {
    // Too soon after the last one. Not dropped — deferred, so a link that
    // settles down five seconds from now still gets its one refresh.
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(runReconnectRefresh, RECONNECT_MIN_GAP_MS - since);
    return;
  }
  reconnectRunning = true;
  lastReconnectAt = Date.now();
  try {
    // Before any refresh: everything done while the connection was gone goes
    // out, in the order it was done. A refresh first would re-read the server's
    // pre-change state and race the queue that is about to change it.
    await flushOutbox().catch((e) => console.error('outbox flush failed', e));
    // Force a real IMAP/EWS sync now for every active account (not just a
    // cache re-read) — this is also what lets the server's own push hook
    // (sync.js#notifyNewMail) discover and notify about anything that
    // arrived while this specific device was offline, not just refresh this
    // page's own view.
    await Promise.all(activeAccounts().map((a) => API.syncAccountNow(a.id).catch(() => {})));
  } finally {
    reconnectRunning = false;
  }
  // Those calls take seconds and can themselves be what proves the connection
  // is not really back. Repainting from a server we have just decided is
  // unreachable would be the same flicker one level down.
  if (!Connection.isOnline()) return;
  loadMessages();
  loadFolders();
  refreshUnread();
  // Well after the refresh, not alongside it: the prefetcher's own requests are
  // the last thing a just-recovered server needs.
  Offline.schedulePrefetch(20000);
}

/* ---------- offline: the queue, the banner, and what is switched off ----------
 *
 * Reading offline needs nothing from this file — api.js answers cached GETs on
 * its own, so loadMessages(), showSingleMessage() and loadFolders() simply
 * work. What lives here is everything a CACHE cannot decide: when the queue
 * drains, what the banner says while it hasn't, and which buttons should stop
 * pretending they can do something. */

/** Drain the outbox and say what happened. Actions the server refused outright
 * — the message was moved or deleted from another client while this device was
 * away — are reported rather than retried forever; see outbox.js. */
async function flushOutbox() {
  if (!Outbox.count()) return;
  const r = await Outbox.replay({
    onDropped: (dropped) => toast(
      `${I18n.t('Some queued actions could not be applied — those messages are no longer where they were')} (${dropped.length})`,
      6000),
  });
  if (r.sent) toast(r.sent === 1
    ? I18n.t('Queued action sent')
    : `${I18n.t('Queued actions sent')} (${r.sent})`);
  scheduleReconcile();
  loadFolders();
}

/** The top bar. It has said the same sentence since it was added; now it can
 * say the two things that actually differ — whether there is saved mail to read
 * and whether anything is waiting to go out. */
function updateOfflineBanner() {
  const text = $('.offline-bar-text');
  if (!text) return;
  const queued = Outbox.count();
  const parts = [];
  parts.push(state.offlineHasCache
    ? I18n.t('Offline — showing saved mail. New mail will arrive when the connection is back.')
    : I18n.t('No connection to the Hmelj server — mail can’t be loaded or sent until it’s back.'));
  if (queued) {
    parts.push(queued === 1
      ? I18n.t('1 action is waiting to be sent.')
      : I18n.t('{n} actions are waiting to be sent.').replace('{n}', queued));
  }
  text.textContent = parts.join(' ');
}

/**
 * Switch off the standing controls that cannot work without a server.
 *
 * Not cosmetic. Each of these starts something the server has to go and do —
 * talk to IMAP, run the filters over a mailbox, scan it, hold a message until
 * a chosen time — none of which this device can even begin. Enabled, they fail
 * one toast at a time on top of a banner already saying why; disabled with a
 * reason attached, they say it once and stay out of the way.
 *
 * Deliberately NOT here: everything the outbox can take — read/unread, star,
 * delete, move, archive, spam, compose and send — which keeps working. Nor the
 * per-message server actions (unsubscribe, read receipt, answering an
 * invitation), which are drawn fresh with each card and are rare enough that
 * the ordinary "no connection" error on pressing one is a clearer answer than
 * a button that arrives already dead.
 */
const OFFLINE_DISABLED = [
  '#btn-run-filters',  // filters run server-side, over the whole mailbox
  '#btn-analytics',    // a scan of the mailbox, on the server
  '#btn-send-later',   // the scheduled-send queue lives on the server, not here
];

/**
 * The two places that say "you are offline" for as long as you are.
 *
 * The banner above them announces it; these are what remain once it has been
 * read and scrolled past, and they had to be in the chrome rather than over it
 * — an indicator that disappears the moment you open a message is not an
 * indicator, and on a phone that is exactly what happened.
 *
 * Two of them because one is not enough to cover both screens. #btn-refresh
 * lives inside #msg-list-pane, and on a phone opening a message sets
 * .mobile-show-message, which hides that whole pane — the toolbar, the
 * connection dot and the refresh button with it. The message view's own sticky
 * back row is the only chrome left there, so it carries a second copy.
 *
 * Neither is `disabled`. A disabled button fires no click, and a control that
 * silently does nothing when pressed is the thing that sends someone looking
 * for a bug: pressed, each one says what is going on and what it means for
 * what is on screen.
 */
function applyOfflineMarkers(online) {
  const btn = $('#btn-refresh');
  if (btn) {
    btn.classList.toggle('offline', !online);
    // A refresh that was in flight when the connection went is over, however it
    // ends: nothing will come back to clear this, and .spinning also disables
    // pointer events (see the CSS), which would leave the marker unpressable.
    if (!online) btn.classList.remove('spinning');
    btn.textContent = online ? '⟳' : '⊘';
    if (btn.dataset.onlineTitle === undefined) btn.dataset.onlineTitle = btn.title || '';
    btn.title = online ? btn.dataset.onlineTitle : I18n.t('Offline — showing saved mail');
  }
  const chip = $('#mv-offline-chip');
  if (chip) chip.hidden = online;
}

/** What either marker says when pressed. One sentence on what is on screen,
 *  one on what will happen, and — when something is queued — how much is
 *  waiting, since that is the part a person actually needs to decide anything. */
async function explainOffline() {
  const queued = Outbox.count();
  const lines = [I18n.t('Hmelj can’t reach the server, so it can’t check for new mail. Everything on screen is a copy saved on this device.')];
  if (queued) {
    lines.push(queued === 1
      ? I18n.t('1 action is waiting to be sent.')
      : I18n.t('{n} actions are waiting to be sent.').replace('{n}', queued));
  }
  lines.push(I18n.t('It will catch up on its own as soon as the connection is back.'));
  // bodyHtml rather than the plain `message`, which renders into one div where
  // newlines collapse — three sentences run together as a wall is exactly the
  // thing nobody reads. Each line is escaped on its way in.
  await Dialog.alert('', {
    title: I18n.t('Offline'),
    bodyHtml: lines.map((l) => `<p class="dialog-message">${esc(l)}</p>`).join(''),
  });
}

function applyOfflineAffordances() {
  const online = Connection.isOnline();
  applyOfflineMarkers(online);
  // Also a hook for the stylesheet: .is-offline is what dims the parts of the
  // chrome that are standing by rather than broken.
  document.body.classList.toggle('is-offline', !online);
  for (const sel of OFFLINE_DISABLED) {
    for (const el of document.querySelectorAll(sel)) {
      el.disabled = !online;
      // Keep the button's real tooltip to put back — a button that permanently
      // says "not available while offline" after the connection returned is a
      // worse lie than the one this is preventing.
      if (el.dataset.onlineTitle === undefined) el.dataset.onlineTitle = el.title || '';
      el.title = online ? el.dataset.onlineTitle : I18n.t('Not available while offline');
    }
  }
}

/* ---------- live event stream (SSE) ----------
 * "Something changed, go check" from the server (server/events.js) — makes
 * cross-device sync (mark read/delete/move on one device, see it on
 * another) feel instant instead of waiting on the 15s poll above, which
 * only reacts to the BACKGROUND POLLER's own cycle finishing, not to a
 * direct action taken on another device. Supplements that poll rather than
 * replacing it: if this connection is ever unavailable (a proxy that kills
 * long-lived connections, a browser quirk, mid-reconnect), the 15s poll is
 * still there as the worst-case fallback — exactly today's behavior,
 * nothing regresses if SSE isn't working for some reason. */
let eventSource = null;
let eventRetryMs = 2000;
let eventRetryTimer = null;
let lastEventAttempt = 0;
function connectEvents() {
  if (eventSource || !Connection.isOnline()) return;
  // The backoff has to survive an offline/online flip, not just a failed
  // connection. disconnectEvents() clears the retry timer, so without this
  // every flip opened a fresh EventSource immediately — which is why a flaky
  // link produced a steady stream of /api/events requests to a server that had
  // been refusing them for minutes. Defer to when the backoff actually allows.
  const wait = lastEventAttempt + eventRetryMs - Date.now();
  if (wait > 0) {
    clearTimeout(eventRetryTimer);
    eventRetryTimer = setTimeout(connectEvents, wait);
    return;
  }
  clearTimeout(eventRetryTimer);
  lastEventAttempt = Date.now();
  eventSource = new EventSource('/api/events');
  eventSource.addEventListener('open', () => { eventRetryMs = 2000; });
  eventSource.addEventListener('mail-changed', (e) => {
    // The event now carries the new unread total (server/events.js), so the
    // sidebar/tab-title/app-badge move in this same tick rather than only
    // after reconcileFolders' own round trip lands. Older servers send `{}`,
    // and a total of null means the server couldn't compute one — both fall
    // through to the reconcile below, same as before.
    try {
      const d = JSON.parse(e.data || '{}');
      // Skipped while one of our own writes is in flight: this total was
      // computed server-side before that write landed, so applying it here is
      // exactly the "badge bounces back to the old number" case.
      if (typeof d.total === 'number' && !pendingMutations) { state.unreadTotal = d.total; renderAccounts(); }
    } catch { /* not JSON — just reconcile */ }
    scheduleReconcile();
  });
  // A mailbox-analytics scan finished (server/analytics.js). Announced here,
  // globally, rather than inside the analytics dialog: the scan keeps running
  // server-side after that dialog is closed — and after a page reload — so
  // "it's done" has to reach the user wherever they actually are. The dialog
  // refreshes itself too, but only if it happens to be open on that account.
  eventSource.addEventListener('analytics-scan', (e) => {
    let d = {};
    try { d = JSON.parse(e.data || '{}'); } catch { /* keep the toast generic */ }
    if (!d.done) return;
    const label = state.accounts.find((a) => a.id === d.accountId)?.label || '';
    if (d.error) toast(`${I18n.t('Analytics scan failed')} — ${label}: ${d.error}`, 6000);
    else if (d.cancelled) toast(`${I18n.t('Analytics scan stopped')} — ${label}`);
    else toast(`${I18n.t('Analytics scan finished')} — ${label}: ${(d.scanned || 0).toLocaleString()} ${I18n.t('messages indexed')}`, 6000);
    Analytics.onScanFinished(d.accountId);
  });
  // Sent when a "same everywhere" setting changed on another device
  // (server/index.js's PUT /api/settings): the sidebar's account order, or the
  // muted toggle. Deliberately re-reads just those keys rather than replacing
  // state.settings wholesale — the device-local settings (theme, fonts) live
  // only in this browser's localStorage and the server's copy of them is stale
  // by design (see saveServerSettings).
  eventSource.addEventListener('settings-changed', async () => {
    if (accountEditMode) return; // don't yank the list out from under an in-progress reorder
    try {
      const s = await API.settings();
      state.settings.accountOrder = s.accountOrder || [];
      const mutedChanged = !!s.showMuted !== !!state.settings.showMuted;
      state.settings.showMuted = !!s.showMuted;
      applyShowMuted();
      renderAccounts();
      // Both what the list may show and what the badges count just changed.
      if (mutedChanged) { state.page = 1; loadMessages(); refreshUnread(); }
    } catch { /* offline or logged out — next boot picks it up */ }
  });
  // EventSource retries a dropped connection on its own, but ONLY for a
  // transport-level drop. A non-2xx response or a wrong Content-Type — an
  // expired session answering 401, a proxy 502, a login redirect serving
  // HTML — is a FATAL error per spec: readyState goes CLOSED and the browser
  // never retries. Without this handler the variable above stayed truthy, so
  // the `if (eventSource)` guard made every later connectEvents() (from
  // visibilitychange, from 'online') a silent no-op and the app degraded
  // permanently to the 15s poll with nothing indicating why. Reconnect
  // ourselves, backing off so a server that's genuinely down isn't hammered.
  eventSource.addEventListener('error', () => {
    if (eventSource?.readyState !== EventSource.CLOSED) return; // still CONNECTING — its own retry is running, leave it alone
    eventSource = null;
    clearTimeout(eventRetryTimer);
    eventRetryTimer = setTimeout(() => {
      connectEvents();
      // Only when there is something to reconcile AGAINST. Offline this read is
      // answered from the cache, so it repainted the sidebar on every failed
      // reconnect — work, and a flicker, for an answer we already had.
      if (Connection.isOnline()) scheduleReconcile(2);
    }, eventRetryMs);
    eventRetryMs = Math.min(60000, eventRetryMs * 2);
  });
}
function disconnectEvents() {
  clearTimeout(eventRetryTimer);
  if (!eventSource) return;
  eventSource.close();
  eventSource = null;
}
// Mobile browsers can throttle or silently kill a background tab's network
// activity (including an open EventSource) outside of a clean 'offline'
// event — coming back to a backgrounded PWA tab always reconnects if
// needed and forces one reconcile pass, so it's never stale for longer
// than it takes to actually look at it again.
/* ---------- keep the screen awake ---------- */

/**
 * Stops the screen dimming and locking while Hmelj is open, when
 * `settings.keepScreenOn` is on (the default, which is what the Android app
 * has always done — it set FLAG_KEEP_SCREEN_ON unconditionally, with no way to
 * turn it off).
 *
 * Two mechanisms, because they are the two kinds of install:
 *
 *  - The native Android shell holds a real window flag. Android's WebView does
 *    not implement the Wake Lock API at all (`navigator.wakeLock` is simply
 *    undefined there, in every version), so the APK can only be told through
 *    the bridge — which is why it is checked first, and why nothing below is a
 *    fallback for it.
 *  - Everywhere else, the Screen Wake Lock API: Chrome/Edge on Android, and
 *    iOS 16.4+. Absent anywhere older, hence the capability check rather than
 *    a version one.
 *
 * Deliberately touch-devices-only for the web path. A wake lock is what a
 * phone propped up on a desk wants; a desktop browser tab quietly preventing
 * the display from ever sleeping is not something anyone asked this app for,
 * and the setting reads as being about a phone. The APK is by definition a
 * phone, so the bridge path is not gated.
 */
let screenWakeLock = null;

function keepScreenOnWanted() {
  return state.settings.keepScreenOn !== false;
}

async function applyKeepScreenOn() {
  const want = keepScreenOnWanted();
  if (window.AndroidApp?.setKeepScreenOn) { window.AndroidApp.setKeepScreenOn(want); return; }
  if (!navigator.wakeLock || !matchMedia('(any-pointer: coarse)').matches) return;
  try {
    if (!want) {
      const held = screenWakeLock;
      screenWakeLock = null;
      await held?.release();
      return;
    }
    if (screenWakeLock) return;
    const lock = await navigator.wakeLock.request('screen');
    // The browser releases the lock itself whenever the page is hidden (the
    // phone locking, another app coming forward, the tab going to the
    // background). Forgetting the reference here is what lets the
    // visibilitychange handler below take a fresh one on the way back —
    // re-requesting on a released lock object does nothing.
    lock.addEventListener('release', () => { if (screenWakeLock === lock) screenWakeLock = null; });
    screenWakeLock = lock;
  } catch (e) {
    // A request is only allowed while the page is actually visible, and can be
    // refused outright (battery saver on Android). Neither is worth telling
    // the user about: the screen simply behaves as it normally would.
    console.debug('Screen wake lock unavailable:', e?.message || e);
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  connectEvents();
  scheduleReconcile();
  recheckPushRegistration();
  // The browser drops a screen wake lock whenever the page goes away; coming
  // back is the only moment a new one can be taken.
  applyKeepScreenOn();
});

/**
 * Push registrations don't only get created — they get LOST. A push service
 * expires an endpoint it hasn't been able to deliver to, the browser rotates
 * one on its own (profile restore, quota churn), and the server prunes
 * whatever comes back dead. The repair for all of that ran only at boot
 * (ensurePushRegistered), which on a machine where Hmelj lives in a pinned
 * tab for weeks is approximately never — so a device could quietly fall out
 * of Settings' device list and stop receiving anything, while the
 * notifications checkbox still read as on, because that's ONE setting shared
 * by the whole login rather than a per-device fact. Re-checking when you come
 * back to the tab costs one small request at most a few times a day.
 */
const PUSH_RECHECK_MS = 6 * 3600e3;
let lastPushCheck = Date.now(); // boot's own ensurePushRegistered() counts as the first check
function recheckPushRegistration() {
  if (Date.now() - lastPushCheck < PUSH_RECHECK_MS) return;
  lastPushCheck = Date.now();
  ensurePushRegistered().catch(() => { /* offline, or logged out — the next visibility change tries again */ });
}

/* ---------- Web Push subscribe/unsubscribe ----------
 * The actual notification is shown by sw.js's 'push' listener (works even
 * with this page closed) — everything here is just device registration:
 * turning OS/browser permission + a VAPID key into a PushSubscription the
 * server can target (server/push.js), and telling the server about it. */

// Standard conversion — pushManager.subscribe() needs the VAPID public key
// (base64url, as served by /api/session) as a raw Uint8Array, not a string.
function urlBase64ToUint8Array(base64) {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

// CodexaPush: injected only by the native Android WebView shell wrapping
// this app — real browsers/desktop never define window.CodexaPush at all,
// so every branch below is a strict no-op there. Android's WebView has no
// Service Worker Push API (no navigator.serviceWorker push support), which
// is the whole reason this second path exists — see the bridge's own
// isSupported()/subscribe() contract. Everything else about notifications
// (foreground `new Notification(...)`, `Notification.requestPermission()`)
// is untouched — the shell polyfills those itself.
function codexaPushSupported() {
  return !!(window.CodexaPush && window.CodexaPush.isSupported());
}

function pushSupported() {
  return codexaPushSupported() || ('serviceWorker' in navigator && 'PushManager' in window && !!state.session?.vapidPublicKey);
}

/** Sets the module-level `pushActive` flag from this device's actual current
 * subscription state — called once at boot, and again after subscribe/
 * unsubscribe so the foreground-fallback gate (checkNewMailNotifications)
 * always reflects reality. */
async function detectPushActive() {
  if (codexaPushSupported()) {
    // The bridge exposes no "am I currently subscribed" query (only
    // isSupported()/subscribe()), so this asks the SERVER whether the token
    // this device last registered is still on file. That matters because the
    // old proxy — the shared desktopNotifications setting — is per-account,
    // not per-device: it's on for every device the moment it's on for one, so
    // pushActive was true by definition here, which (a) made the boot
    // re-registration below unreachable in the app and (b) silenced the
    // foreground fallback too. A device whose FCM token was rotated and
    // pruned server-side therefore went permanently quiet with the checkbox
    // still showing "on".
    const token = localStorage.getItem(CODEXA_TOKEN_KEY);
    if (!token) { pushActive = false; return; }
    try {
      const devices = await API.pushSubscriptions();
      pushActive = devices.some((d) => d.token === token);
    } catch {
      pushActive = !!state.settings?.desktopNotifications; // can't ask — assume the setting, and let ensurePushRegistered retry
    }
    return;
  }
  if (!pushSupported()) { pushActive = false; return; }
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = await reg?.pushManager.getSubscription();
    if (!sub) { pushActive = false; return; }
    // A live local subscription isn't enough — Settings' device list can drop
    // one server-side (and the server prunes dead endpoints on its own).
    // Locally it still looks subscribed, which used to leave the device
    // getting neither push NOR the foreground fallback, forever, with nothing
    // in the UI explaining why.
    try {
      const devices = await API.pushSubscriptions();
      pushActive = devices.some((d) => d.endpoint === sub.endpoint);
    } catch { pushActive = true; }
  } catch { pushActive = false; }
}

/** The id this device is registered under — a Web Push endpoint, or the
 * native shell's FCM token. Settings uses it to mark which row of the device
 * list is the machine you're actually looking at; two laptops running the
 * same browser version are otherwise indistinguishable there, and a device
 * that has silently lost its registration looks the same as one that was
 * never there. null when this device isn't registered at all. */
async function currentPushDeviceId() {
  if (codexaPushSupported()) return localStorage.getItem(CODEXA_TOKEN_KEY);
  if (!pushSupported()) return null;
  try {
    // getRegistration() answers only for THIS page's scope. getRegistrations()
    // is the fallback for a subscription living under a different one (an
    // older build's registration, an install under a subdirectory) — it is
    // still this browser's one push subscription, which is all we're after.
    const regs = [];
    const scoped = await navigator.serviceWorker.getRegistration();
    if (scoped) regs.push(scoped);
    for (const r of (await navigator.serviceWorker.getRegistrations?.()) || []) if (!regs.includes(r)) regs.push(r);
    for (const r of regs) {
      const sub = await r.pushManager?.getSubscription();
      if (sub?.endpoint) return sub.endpoint;
    }
    return null;
  } catch { return null; }
}

/**
 * Make sure this device is registered with the server for push, re-doing it
 * if the registration went missing. Runs on every boot.
 *
 * This is the single most important fix for "notifications worked for a
 * while, then stopped": push registrations expire on their own. The browser
 * rotates a PushSubscription (cert/quota churn, profile restore) and Android
 * rotates the FCM token (reinstall, app-data clear, periodic refresh). Either
 * way the server's copy stops working, gets pruned as dead, and nothing ever
 * registered a replacement — the app only ever subscribed at the moment the
 * user first ticked the Settings checkbox.
 */
async function ensurePushRegistered() {
  if (!state.settings?.desktopNotifications) return;          // user doesn't want them
  if (typeof Notification !== 'undefined' && Notification.permission !== 'granted') return; // no OS permission — enableNotifications() is the path back
  await detectPushActive();
  if (pushActive) return;
  await subscribeForPush();
}

// Device-local only (localStorage, not synced anywhere) — needed because
// unsubscribeFromPush() below has to tell the server which FCM token to drop,
// and (unlike a real PushSubscription) the bridge gives no way to ask for
// the current token back later; this is the only place it's ever recorded.
const CODEXA_TOKEN_KEY = 'hmelj-codexa-push-token';

async function subscribeForPush() {
  if (codexaPushSupported()) {
    try {
      const token = await window.CodexaPush.subscribe();
      await API.pushSubscribe({ type: 'fcm', token }, navigator.userAgent);
      localStorage.setItem(CODEXA_TOKEN_KEY, token);
      pushActive = true;
      return true;
    } catch (e) {
      console.warn('CodexaPush subscribe failed:', e); // denied, or unavailable — same UI/error state as declining the browser permission prompt
      return false;
    }
  }
  if (!pushSupported()) return false;
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(state.session.vapidPublicKey),
    });
    await API.pushSubscribe(sub.toJSON(), navigator.userAgent);
    pushActive = true;
    return true;
  } catch (e) {
    console.warn('Push subscribe failed:', e);
    return false;
  }
}

async function unsubscribeFromPush() {
  pushActive = false;
  if (codexaPushSupported()) {
    // No native revoke exposed by the bridge either — this can only drop
    // our own server-side registration (stop targeting this device), same
    // limitation a plain website already has toward browser Notification
    // permission (there's no way to un-grant that from JS either). If there
    // was never a recorded token (e.g. subscribe failed earlier), there's
    // nothing to remove server-side.
    const token = localStorage.getItem(CODEXA_TOKEN_KEY);
    if (token) {
      await API.pushUnsubscribe(token).catch(() => {});
      localStorage.removeItem(CODEXA_TOKEN_KEY);
    }
    return;
  }
  if (!pushSupported()) return;
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = await reg?.pushManager.getSubscription();
    if (!sub) return;
    const endpoint = sub.endpoint;
    await sub.unsubscribe();
    await API.pushUnsubscribe(endpoint).catch(() => {});
  } catch (e) { console.warn('Push unsubscribe failed:', e); }
}

/** Turns notifications on: Notification permission first (the OS-level gate
 * both paths need), then a push subscription where the browser supports one
 * — falling back to the old foreground-only behavior otherwise, silently,
 * so "not supported here" isn't a dead end. Shared by both places that ask
 * (the once-per-device auto-prompt and the Settings checkbox) so they can't
 * drift out of sync with each other. */
async function enableNotifications() {
  if (typeof Notification === 'undefined') return false;
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') return false;
  await subscribeForPush(); // best-effort — desktopNotifications still turns on below even if this fails/isn't supported
  state.settings = await saveServerSettings({ desktopNotifications: true }).catch(() => state.settings);
  return true;
}

async function disableNotifications() {
  await unsubscribeFromPush();
  state.settings = await saveServerSettings({ desktopNotifications: false }).catch(() => state.settings);
}

/** Messages from sw.js — see its 'push' and 'notificationclick' handlers. */
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data?.type === 'hmelj-refresh') {
      scheduleReconcile();
    } else if (e.data?.type === 'hmelj-open-message') {
      openMessageDeepLink(e.data.accountId, e.data.folder, e.data.uid);
    } else if (e.data?.type === 'hmelj-open-calendar') {
      // A tapped calendar reminder. The calendar is a view rather than a
      // folder, so this is a navigation and not a message open.
      openFolder(CALENDAR_FOLDER);
    }
  });
}

/** Open a specific message by raw ids alone — no list-row object on hand
 * (the notification that sent us here only carries account/folder/uid), used
 * both by the SW message listener above and the ?msgAccount=/msgFolder=/
 * msgUid= boot-time deep link (a fresh window opened because no existing
 * Hmelj tab was found to postMessage into instead — see sw.js). */
async function openMessageDeepLink(accountId, folder, uid) {
  if (!accountId || !folder || uid === undefined) return;
  if (state.currentAccount !== accountId) await switchAccount(accountId);
  window.focus();
  openMessage({ uid, folder, account: { id: accountId }, seen: false });
}

/** Resolve a message's own folder + account (unified view) and hand both to fn explicitly
 * — no shared-state mutation, so no risk of racing a concurrent account switch. */
function withMsgCtx(m, fn) {
  const folder = m.folder || state.currentFolder;
  return fn(folder, m.account?.id);
}

/** The same resolution as a plain pair, for callers that hold onto it rather
 * than handing it straight to one call (quickDelete keeps it so its undo can
 * put the message back where it came from, long after the row is gone). */
function msgCtx(m) {
  return withMsgCtx(m, (folder, accountId) => ({ folder, accountId }));
}

/** Every message a row's actions may touch.
 *
 * With conversation view on, a row IS a conversation, and starring, deleting
 * or marking it read has to mean the whole thing — a thread that stays half
 * unread after you read it reads as a bug. threadUids is the server's answer to
 * "which of those live in the folder you are looking at" (cache.js#
 * threadRowToMessage): never the replies in your Sent folder, which deleting an
 * Inbox conversation must leave alone.
 *
 * Ungrouped (or a conversation of one) this is just the message itself, which
 * is what every caller did before threading existed. */
function rowUids(m) {
  return m.threadUids?.length ? m.threadUids : [m.uid];
}

/** Is this row a real conversation (more than one message), rather than a
 *  single message the grouped query happened to return? */
function isThreadRow(m) {
  return (m.threadCount || 1) > 1;
}

/** A row's unread state: any unread message in the conversation. */
function rowUnread(m) {
  return m.threadUids ? (m.threadUnseen || 0) > 0 : !m.seen;
}

/**
 * The whole indication that a row is more than one message.
 *
 * Inside the subject cell rather than a column of its own — the row layouts
 * (table/compact/comfort/…) have no spare column to give it on a phone — and
 * BEFORE the subject, for the same reason the reply marker is: the cell
 * ellipsises, so anything after the text disappears on exactly the long
 * subjects a conversation is most likely to have.
 */
function threadMarkHtml(m) {
  if (!isThreadRow(m)) return '';
  return `<span class="m-thread" title="${escAttr(I18n.t('Messages in this conversation'))}">${m.threadCount}</span>`;
}

/** A row's star: starred if anything in the conversation is. */
function rowStarred(m) {
  return m.threadUids ? !!m.threadFlagged : !!m.flagged;
}

/* ---------- list sorting ---------- */
function sortMessages(list) {
  const by = state.settings.sortBy || 'date';
  const dir = state.settings.sortDir || 'desc';
  const val = (m) => {
    if (by === 'sender') return (m.from?.name || m.from?.address || '').toLowerCase();
    if (by === 'subject') return (m.subject || '').toLowerCase();
    return new Date(m.date || 0).getTime();
  };
  const sorted = [...list].sort((a, b) => {
    const va = val(a); const vb = val(b);
    if (va < vb) return -1;
    if (va > vb) return 1;
    return 0;
  });
  if (dir === 'desc') sorted.reverse();
  return sorted;
}

function updateSortHeader() {
  for (const el of $$('.col-head')) {
    const active = el.dataset.sort === (state.settings.sortBy || 'date');
    el.classList.toggle('active', active);
    const arrow = el.querySelector('.sort-arrow');
    if (arrow) arrow.dataset.dir = active ? (state.settings.sortDir === 'asc' ? '▲' : '▼') : '';
  }
}

/** Enter/exit bulk-selection mode: toggles the injected #select-toolbar row
 * and the #msg-list-pane.select-mode class the CSS keys off (swaps each
 * row's account badge for a selection circle in the card layouts, reveals
 * the checkbox in table mode, etc). Leaving select mode always drops the
 * current selection — there's no use for a leftover selection once the
 * controls to act on it are hidden again. */
function setSelectMode(on) {
  state.selectMode = on;
  if (!on) state.selected.clear();
  $('#msg-list-pane').classList.toggle('select-mode', on);
  $('#select-toolbar').hidden = !on;
  $('#btn-select-mode').classList.toggle('active', on);
  updateSelectToolbar();
  renderList();
}

/** Keeps the "X selected" count current — called on every selection change. */
function updateSelectToolbar() {
  $('#select-count').textContent = `${state.selected.size} selected`;
}

/** Builds one message-list <li>, wired with its own listeners — shared by
 * the full rebuild (renderList) and the in-place reconcile (patchList) used
 * for silent background refreshes. */
/** The account a row's badge stands for: whatever the server tagged the message
 * with in the unified view, or simply the account being viewed in a
 * single-account one. Null only in the unified view before an account is known.
 * Shared by buildRow() and the Table layout's header, which reserves the badge
 * column — the two must agree or the header ends up a badge-width out of line
 * with the rows underneath it. */
function rowAccount(m) {
  return m.account || (state.currentAccount !== 'all' ? acct() : null);
}

/**
 * The ↩ / ↪ every other mail client draws against a message that has been
 * replied to or forwarded. Not Hmelj's own bookkeeping: it comes from the
 * IMAP \Answered flag and the $Forwarded keyword (on Exchange, from
 * PidTagLastVerbExecuted), so it also lights up for a reply sent from
 * Thunderbird or a phone, and a reply sent from Hmelj shows up in those.
 *
 * Forward wins when a message has both, matching what Outlook does — the last
 * thing you did with it is the useful thing to be reminded of, and showing two
 * arrows in a list row that already fights for width is not worth it.
 */
/**
 * The same state as answerMarkHtml, spelled out in the reading pane where
 * there's room for a sentence — the arrow alone in a list row is a reminder,
 * this is the answer to "did I already deal with this?".
 *
 * Reads the LIST row first (kept live by the flag routes, so it updates the
 * moment you reply without waiting for a poll) and falls back to the fetched
 * message's own flags, which is all that exists in the pop-out window.
 */
function answerNoteHtml(listEntry, msg) {
  const has = (f) => (msg?.flags || []).some((x) => String(x).toLowerCase() === f);
  const forwarded = listEntry?.forwarded ?? has('$forwarded');
  const answered = listEntry?.answered ?? has('\\answered');
  if (!forwarded && !answered) return '';
  const label = forwarded ? I18n.t('You forwarded this message') : I18n.t('You replied to this message');
  return `<div class="mv-answered">${forwarded ? '↪' : '↩'} ${esc(label)}</div>`;
}

/* Rendered INSIDE .m-subject, not as a sibling: the four grid layouts
 * (app.css's grid-template-areas) have no spare cell, and the end of the row is
 * where text-overflow clips — a marker there would vanish on exactly the long
 * subjects most in need of one. Leading the subject keeps it visible in all five
 * layouts and needs no layout rules at all. */
function answerMarkHtml(m) {
  if (m.forwarded) return `<span class="m-answered" title="${escAttr(I18n.t('Forwarded'))}">↪</span>`;
  if (m.answered) return `<span class="m-answered" title="${escAttr(I18n.t('Replied to'))}">↩</span>`;
  return '';
}

function buildRow(m) {
  const li = document.createElement('li');
  li.className = rowClassName(m);
  li.dataset.uid = m.uid;
  const a = acct();
  const isOutgoing = state.currentFolder === '__SENT__' ||
    (a && (state.currentFolder === a.sentFolder || state.currentFolder === a.draftsFolder));
  const fromLabel = isOutgoing
    ? 'To: ' + (m.to?.map((t) => t.name || t.address).join(', ') || '—')
    : (m.from?.name || m.from?.address || '(unknown)');
  // The badge is drawn in a single-account view too now, not only in "All
  // inboxes" — it's a 20px tap target that toggles read/unread, which is worth
  // having everywhere, and it keeps rows aligned identically between the two
  // views (the sender column used to shift sideways on switching). rowAccount()
  // deliberately doesn't write anything onto `m`: withMsgCtx/batchOp/
  // adjustUnreadCounts all read a present m.account as "this row came from an
  // account other than the one being viewed", which must stay true.
  const chipAccount = rowAccount(m);
  const chip = chipAccount
    ? `<span class="acct-chip" style="--chip:${escAttr(chipAccount.color)}" title="${escAttr(chipAccount.label)} — ${escAttr(I18n.t('click to mark read/unread'))}">${esc(acctInitials(chipAccount.label))}</span>` : '';
  li.innerHTML = `
    <label class="cb" title="Select"><input type="checkbox" ${state.selected.has(m.uid) ? 'checked' : ''}></label>
    <button class="m-star ${rowStarred(m) ? 'on' : ''}" title="Star">${rowStarred(m) ? '★' : '☆'}</button>
    ${chip}<span class="m-from">${esc(fromLabel)}</span>
    <!-- data-no-i18n: this span holds the user's MAIL, not the app's own words
         — a subject (or a shortened one, see below) that happened to match a
         catalogue entry would otherwise come back translated. The ↩/↪/count
         marks inside are already translated where they're built, and a language
         change reloads the page anyway.
         title: subjectOriginal is set by the server only on a row whose
         subject was rewritten by a Settings > Subject rule
         (server/subjectRules.js), so hovering a shortened row still shows what
         the sender actually wrote. -->
    <span class="m-subject" data-no-i18n title="${escAttr(m.subjectOriginal || m.subject || '')}">${draftMarkHtml(m)}${answerMarkHtml(m)}${threadMarkHtml(m)}${esc(m.subject)}</span>
    ${m.hasAttachment ? '<span class="m-attach" title="Has attachment">📎</span>' : ''}
    <span class="m-date" title="${escAttr(fmtDate(m.date, { long: true }))}">${esc(fmtDate(m.date))}</span>`;
  li.querySelector('.m-star').addEventListener('click', async (e) => {
    e.stopPropagation();
    // A conversation row draws one star for the whole thread, so the click has
    // to move the whole thread — otherwise unstarring a row it says is starred
    // would leave it starred, because some OTHER message in it still is.
    const on = !rowStarred(m);
    try {
      await trackMutation(withMsgCtx(m, (folder, acct) => API.flags(folder, rowUids(m), on ? ['\\Flagged'] : [], on ? [] : ['\\Flagged'], acct)));
    } catch (err) {
      toast('Could not star message: ' + err.message);
      return;
    }
    m.flagged = on;
    if (m.threadUids) m.threadFlagged = on;
    renderList();
  });
  // One tap on the account badge toggles read/unread — the fastest way to do
  // it on desktop (mirroring the mobile swipe gesture), and now available in
  // every view rather than only the unified one (see the `chip` var above).
  // Hidden in select-mode by CSS already (swapped for the selection circle
  // there), so no separate guard needed here.
  li.querySelector('.acct-chip')?.addEventListener('click', (e) => {
    e.stopPropagation();
    quickToggleRead(m);
  });
  // The checkbox is only ever visible (see CSS) while state.selectMode is
  // on, so a click on it always means "toggle this row's selection" — no
  // separate listener needed, it's covered by the row-level one below via
  // bubbling. Marking as read/unread moved to the select-mode toolbar
  // (batch action on whatever's selected) — there's no more per-row icon
  // for it, see #select-toolbar's #sel-read/#sel-unread.
  li.addEventListener('click', (e) => {
    // Shift+click takes everything between the last row clicked and this one —
    // click a message, hold Shift, click five below it, and all six are picked.
    // Checked BEFORE Ctrl so Ctrl+Shift+click means "extend", the way it does
    // everywhere else. Desktop only, for the same reason as Ctrl below.
    //
    // Unlike Ctrl+click this also works once select mode is already ON: that is
    // the whole point of it, extending a selection you have started rather than
    // ticking twenty rows one at a time.
    if (e.shiftKey && !isMobileViewport()) {
      // No anchor in this list (first click after a folder switch, or one left
      // behind on another page) — nothing to draw a range from, so fall back to
      // exactly what Ctrl+click would have done with this row.
      if (!selectRangeTo(m)) {
        for (const u of rowUids(m)) state.selected.add(u);
        state.selectAnchorUid = m.uid;
      }
      // setSelectMode re-renders (and never clears the set on the way IN), so
      // the newly-picked rows come back already ticked; once it is already on,
      // a plain renderList does the same job. Either way the "X selected" count
      // follows, since renderList ends by updating it.
      if (state.selectMode) renderList(); else setSelectMode(true);
      return;
    }
    // Any click WITHOUT Shift is where the next range will start from — whether
    // it opens the message, Ctrl-picks it, or ticks it in select mode. That is
    // what makes "click one, Shift+click another" work without a separate
    // gesture to place the anchor.
    state.selectAnchorUid = m.uid;
    // Ctrl+click (Cmd on a Mac) picks rows out of the list without going to the
    // toolbar's ☑ first — the desktop convention, and what the drag-to-select
    // gesture's space is now free for (see .msg-list's user-select in app.css).
    // Desktop only: a touch screen has no modifier key, and a long press
    // already means something else on these rows.
    if (multiSelectClick(e) && !state.selectMode && !isMobileViewport()) {
      // Before setSelectMode, which is what re-renders the list — so the row
      // this started from comes back already ticked. It does not clear the set
      // when turning select mode ON, only off.
      for (const u of rowUids(m)) state.selected.add(u);
      setSelectMode(true);
      return;
    }
    if (state.selectMode) {
      // Every message of the conversation goes in or out together — state.selected
      // is a flat uid set and every batch action reads it as one (batchOp), so
      // nothing downstream needs to know threads exist.
      const uids = rowUids(m);
      if (state.selected.has(m.uid)) for (const u of uids) state.selected.delete(u);
      else for (const u of uids) state.selected.add(u);
      li.className = rowClassName(m);
      const cb = li.querySelector('.cb input'); if (cb) cb.checked = state.selected.has(m.uid);
      updateSelectToolbar();
      return;
    }
    openMessage(m);
  });
  li.addEventListener('contextmenu', (e) => { e.preventDefault(); showMessageMenu(m, e.clientX, e.clientY); });
  bindLongPress(li, (x, y) => showMessageMenu(m, x, y));
  bindSwipe(li, m);
  return li;
}

/**
 * Every message row currently ON SCREEN, in the order it is shown.
 *
 * Read back out of the DOM rather than re-deriving it from state.messages and
 * sortMessages(): a range means "everything between these two AS DISPLAYED",
 * and the list on screen is the only thing that knows that for certain — a
 * second opinion computed from the array would silently disagree the moment the
 * two ever drifted (a sort change, a row the list chose not to draw).
 */
function renderedRows() {
  const byUid = new Map(state.messages.map((m) => [String(m.uid), m]));
  return [...$('#msg-list').querySelectorAll('.msg-row')]
    .map((li) => byUid.get(li.dataset.uid))
    .filter(Boolean);
}

/**
 * Shift+click: add every row between the anchor (see state.selectAnchorUid) and
 * `m` to the selection, both ends included.
 *
 * Additive, and the anchor deliberately does NOT move: a second Shift+click
 * extends the same range further instead of replacing it, so the gesture can
 * only ever grow a selection. File-manager behaviour would re-cut the range
 * from the anchor and drop whatever fell outside it — which, in a mailbox, is
 * one mis-aimed click away from silently unpicking messages you had already
 * chosen to delete.
 *
 * Whole conversations go in together (rowUids), exactly as a plain select-mode
 * click does — state.selected is a flat uid set and nothing downstream knows
 * threads exist.
 *
 * @returns {boolean} false if there is no usable anchor in the current list,
 *   which is the caller's cue to treat the click as an ordinary Ctrl+click.
 */
function selectRangeTo(m) {
  if (state.selectAnchorUid == null) return false;
  const rows = renderedRows();
  const to = rows.findIndex((r) => String(r.uid) === String(m.uid));
  const from = rows.findIndex((r) => String(r.uid) === String(state.selectAnchorUid));
  // An anchor left over from another folder or an earlier page simply isn't
  // here any more — no range to draw, rather than a wrong one.
  if (to < 0 || from < 0) return false;
  const [a, b] = from <= to ? [from, to] : [to, from];
  for (let i = a; i <= b; i++) for (const u of rowUids(rows[i])) state.selected.add(u);
  return true;
}

/**
 * Is this click the "add to a selection" gesture?
 *
 * Ctrl everywhere except a Mac, where Ctrl+click IS the right-click gesture and
 * would fire the row's context menu at the same time — there it is Cmd, which
 * is that platform's multi-select modifier anyway.
 */
const IS_MAC = /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent || '');
function multiSelectClick(e) {
  return IS_MAC ? e.metaKey : e.ctrlKey;
}

function rowClassName(m) {
  // The keyboard cursor rides on top of every other row state — it says where
  // the next j/k/Del will land, which matters most precisely when the row is
  // also selected or open.
  const cursor = state.cursorUid != null && String(state.cursorUid) === String(m.uid) ? ' cursor' : '';
  return 'msg-row' + (rowUnread(m) ? ' unread' : '') + (m.uid === state.openUid ? ' selected' : '') + (m.deleted ? ' deleted' : '') +
    (state.selectMode && state.selected.has(m.uid) ? ' picked' : '') + cursor;
}

/**
 * The folder a conversation should be read against: the one being LISTED, not
 * the one the row's newest message happens to sit in.
 *
 * A row in the Inbox whose newest message is a reply YOU sent carries
 * `folder: 'Sent'` — it IS that message. Asking the server for the thread with
 * that folder scoped it to [Sent, Sent] and produced a stack of nothing but
 * your own messages, in conversations that plainly had two sides. The server
 * scopes the count the same way (see threadScopeFolders there), so the two have
 * to be given the same folder or the row's number and its stack disagree.
 *
 * Smart folders ('__SENT__', the unified inbox) aren't real paths the server
 * can scope to, so those fall back to the row's own folder.
 */
function listedFolderFor(m) {
  const f = state.currentFolder;
  if (!f || f.startsWith('__') || state.currentAccount === 'all') return m.folder || f;
  return f;
}

/** The `scope` an /api/messages or /api/unified call should carry, or undefined
 *  for the ordinary cached read. Only ever 'account' while a search is active —
 *  a scoped sweep of nothing is just a slow way to list a folder. */
function searchScopeParam() {
  return state.query && state.searchScope === 'account' ? 'account' : undefined;
}

/**
 * The line under a search's results explaining what was actually searched, and
 * offering the rest.
 *
 * This exists because the default answer is a narrow one and never said so: an
 * ordinary search reads the local cache, which holds each folder's newest
 * `syncBackfillLimit` messages and indexes only their subject, sender and
 * recipients. On a mailbox with 19 000 messages and a 500-message window, "two
 * results" can look like the whole truth. The link asks the SERVER instead:
 * every folder of the account — All Mail where the provider has one, which is
 * the only place archived Gmail lives — matching message bodies too.
 *
 * It says what the server reports it actually DID (state.searchScopeUsed), not
 * what was asked for, because those come apart in the case that matters most: a
 * `body:` term is answered live over the folder's entire history even at the
 * default scope. Claiming "only recently cached mail was searched" there sent a
 * real investigation off after the cache when the thing actually missing was a
 * message sitting one folder over, filed there by a rule. Whatever was searched,
 * the line now names the boundary the results stop at.
 */
const SEARCH_SCOPE_TEXT = {
  account: 'Searched the whole account on the server.',
  starred: 'Searched every folder on the server for starred mail.',
  folder: 'Searched this whole folder on the server, not just cached mail.',
  inboxes: "Searched each account's inbox on the server, not just cached mail.",
  cache: 'Only recently cached mail was searched, by subject and sender.',
  // The index covers whole messages, but only the ones whose content is cached
  // — a shallower window than the envelope cache above, not a deeper one. So
  // this says what was read rather than implying the whole mailbox, and keeps
  // the escalation link for the mail that sits behind that window.
  index: 'Searched inside recently cached messages, including their text.',
};

function searchScopeRow() {
  if (!state.query) return null;
  const li = document.createElement('li');
  li.className = 'search-scope-row';
  // 'account' and 'starred' already span every folder there is to span — there
  // is nothing left to escalate to, so they get the line without the button.
  const used = state.searchScopeUsed || 'cache';
  if (used === 'account' || used === 'starred') {
    li.innerHTML = `<span>${esc(I18n.t(SEARCH_SCOPE_TEXT[used]))}</span>
      <button type="button" class="link-btn" id="search-save">${esc(I18n.t('Save this search'))}</button>`;
    $('#search-save', li).addEventListener('click', saveCurrentSearch);
    return li;
  }
  li.innerHTML = `<span>${esc(I18n.t(SEARCH_SCOPE_TEXT[used] || SEARCH_SCOPE_TEXT.cache))}</span>
    <button type="button" class="link-btn" id="search-everywhere">${esc(I18n.t('Search everywhere'))}</button>
    <button type="button" class="link-btn" id="search-save">${esc(I18n.t('Save this search'))}</button>`;
  $('#search-save', li).addEventListener('click', saveCurrentSearch);
  $('#search-everywhere', li).addEventListener('click', () => {
    state.searchScope = 'account';
    state.page = 1;
    // The sweep is a live SEARCH per folder and can genuinely take seconds, so
    // say so where the results are rather than leaving the old ones sitting
    // there looking current.
    $('#msg-list').innerHTML = `<li class="msg-list-loading">${esc(I18n.t('Searching the server…'))}</li>`;
    loadMessages();
  });
  return li;
}

function renderList() {
  // The Scheduled view is not backed by state.messages (see paintScheduled).
  // renderList() is what every open and close of the reading pane calls, so
  // without this the queue would be replaced by "No messages here" the moment
  // a queued message was opened.
  if (state.currentFolder === SCHEDULED_FOLDER) return paintScheduled();
  if (state.currentFolder === OUTBOX_FOLDER) return renderOutbox();
  if (state.currentFolder === SNOOZED_FOLDER) return paintSnoozed();
  // The calendar draws itself into its own pane; renderList has nothing to do.
  if (inCalendar()) return;
  const ul = $('#msg-list');
  ul.innerHTML = '';
  $('#lh-chip').hidden = !state.messages.some((m) => rowAccount(m));
  updateSortHeader();
  // These rows were assembled on this device out of saved message headers, not
  // answered by the server (see loadMessages' offline branch). Say so where the
  // results are: "no matches" from a local search means "none among the mail
  // this device kept", which is a materially different statement, and one the
  // reader has to be told before they conclude a message isn't there.
  if (state.listLocal) {
    const note = document.createElement('li');
    note.className = 'msg-list-note';
    note.textContent = I18n.t('Offline — showing only mail saved on this device.');
    ul.appendChild(note);
  }
  if (!state.messages.length) {
    if (hasNoAccounts()) { renderNoAccountState(); return; }
    // Appended, not assigned: the offline note above it is part of the answer
    // — "nothing here" and "nothing here among what was saved" are different
    // sentences, and overwriting the list would leave only the first.
    ul.insertAdjacentHTML('beforeend', '<li style="padding:28px;text-align:center;color:var(--text-dim)">No messages here. Enjoy the silence. 🌿</li>');
    const emptyScopeRow = searchScopeRow();
    if (emptyScopeRow) ul.appendChild(emptyScopeRow); // "nothing found" is exactly when the wider search is worth offering
    updateSelectToolbar();
    return;
  }
  for (const m of sortMessages(state.messages)) {
    ul.appendChild(buildRow(m));
  }
  const scopeRow = searchScopeRow();
  if (scopeRow) ul.appendChild(scopeRow);
  updateSelectToolbar();
  // The keyboard cursor is a class on a row and the list is rebuilt often —
  // shortcuts.js listens for this rather than renderList knowing about it.
  document.dispatchEvent(new CustomEvent('hmelj:list-rendered'));
}

/** Applies the chosen row-density layout (table/small/compact/comfort/wide)
 * to #msg-list-pane via a data-layout attribute the CSS keys off. "table"
 * (single-line columns) can't fit a narrow phone screen, so on a mobile
 * viewport it's shown as "compact" instead — same override the CSS used to
 * apply unconditionally before Layout became a user choice. Re-run on every
 * crossing of the mobile breakpoint (see the matchMedia listener below) so
 * resizing the window or rotating a device keeps this correct live. */
function applyListLayout() {
  const chosen = state.settings.listLayout || 'table';
  const effective = (chosen === 'table' && isMobileViewport()) ? 'compact' : chosen;
  $('#msg-list-pane').dataset.layout = effective;
  for (const btn of $$('#layout-menu button')) btn.classList.toggle('active', btn.dataset.layout === chosen);
}
matchMedia('(max-width: 900px)').addEventListener('change', () => { if (state.settings) applyListLayout(); });

/** Signature of {uid, seen, flagged, deleted} per message, order-sensitive —
 * used to detect "nothing actually changed" so a silent background refresh
 * can skip touching the DOM entirely instead of causing a visible flash. */
function messagesSignature(list) {
  // Every per-message bit a row DRAWS has to be in here. reconcileMessages()
  // returns early when this is unchanged, so a state the signature omits stays
  // invisible until something forces a full reload — which is exactly what
  // happened to the reply/forward marker before answered/forwarded were added.
  return list.map((m) => `${m.uid}:${m.seen ? 1 : 0}:${m.flagged ? 1 : 0}:${m.deleted ? 1 : 0}:${m.answered ? 1 : 0}:${m.forwarded ? 1 : 0}:${m.threadCount || 1}:${m.threadUnseen || 0}`).join(',');
}

/** In-place keyed diff against the currently-rendered list — used only for
 * silent background refreshes (see pollSyncStatus). Unlike renderList(),
 * this never wipes #msg-list: existing rows for uids still present get
 * patched (read/flag/deleted state, position), rows for uids no longer
 * present are removed, and only genuinely new uids get a freshly built row.
 * Nothing here should be visible as a flash for an unaffected row. */
function patchList() {
  const ul = $('#msg-list');
  $('#lh-chip').hidden = !state.messages.some((m) => rowAccount(m));
  updateSortHeader();
  const sorted = sortMessages(state.messages);
  if (!sorted.length) { renderList(); return; }
  const existing = new Map($$('#msg-list > li[data-uid]').map((li) => [li.dataset.uid, li]));
  const kept = new Set();
  let prev = null;
  for (const m of sorted) {
    const key = String(m.uid);
    kept.add(key);
    let li = existing.get(key);
    if (li) {
      li.className = rowClassName(m);
      const cb = li.querySelector('.cb input'); if (cb) cb.checked = state.selected.has(m.uid);
      const star = li.querySelector('.m-star');
      if (star) { star.classList.toggle('on', rowStarred(m)); star.textContent = rowStarred(m) ? '★' : '☆'; }
      // A conversation that just gained a message keeps its row, so the count
      // has to be patched in place — nothing else here would repaint it.
      const chip = li.querySelector('.m-thread');
      const wantChip = isThreadRow(m);
      if (chip && wantChip) chip.textContent = m.threadCount;
      else if (chip || wantChip) {
        // Gained (or lost) its conversation badge — rebuild the row rather
        // than splicing markup into the middle of the subject cell. It stays
        // in place; the reposition below still owns where it ends up.
        const fresh = buildRow(m);
        li.replaceWith(fresh);
        li = fresh;
      }
      // The reply/forward marker changes on rows that are already on screen —
      // you reply to the message you're looking at — and nothing else here
      // repaints it, so a patched row would keep showing no arrow until the
      // next full renderList().
      const mark = li.querySelector('.m-answered');
      const wantMark = answerMarkHtml(m);
      if (!wantMark) mark?.remove();
      else if (mark) mark.outerHTML = wantMark;
      else li.querySelector('.m-subject')?.insertAdjacentHTML('afterbegin', wantMark);
    } else {
      li = buildRow(m);
    }
    const wantPrevSibling = prev ? prev.nextSibling : ul.firstChild;
    if (wantPrevSibling !== li) ul.insertBefore(li, wantPrevSibling);
    prev = li;
  }
  for (const [key, li] of existing) if (!kept.has(key)) li.remove();
  // The search footer isn't keyed by uid, so the diff above leaves it alone —
  // but it has to stay LAST once rows have been reordered around it.
  const scopeRow = $('.search-scope-row', ul);
  if (scopeRow) ul.appendChild(scopeRow);
  // Same for the offline note at the other end: the insert anchor above is
  // ul.firstChild, so a reordering pass would otherwise leave the caveat
  // stranded halfway down the results it is a caveat about.
  const note = $('.msg-list-note', ul);
  if (note) ul.insertBefore(note, ul.firstChild);
  updateSelectToolbar();
}

function renderPager(data) {
  const pager = $('#pager');
  const pages = Math.max(1, Math.ceil(data.total / data.pageSize));
  const from = data.total ? (data.page - 1) * data.pageSize + 1 : 0;
  const to = Math.min(data.total, data.page * data.pageSize);
  // data.total is how many rows are actually cached and pageable — for a
  // folder bigger than the sync backfill setting that's not your real
  // mailbox size. realTotal (server-reported, only present for an
  // unfiltered single-folder view) carries the real count, but showing both
  // inline ate too much space above the list — the total is a plain tap
  // target instead, popping the detail up on demand rather than always.
  const showInfo = data.realTotal != null && data.realTotal > data.total;
  const totalHtml = showInfo
    ? `<button class="pager-total" id="pager-total" title="${escAttr(I18n.t('Cached messages'))}">${data.total}</button>`
    : `${data.total}`;
  pager.innerHTML = `<span>${from}–${to} of ${totalHtml}</span>
    <button ${data.page <= 1 ? 'disabled' : ''} id="pg-prev">‹</button>
    <button ${data.page >= pages ? 'disabled' : ''} id="pg-next">›</button>`;
  $('#pg-prev')?.addEventListener('click', () => { state.page--; loadMessages(); });
  $('#pg-next')?.addEventListener('click', () => { state.page++; loadMessages(); });
  $('#pager-total')?.addEventListener('click', () => {
    const msg = I18n.t('{cached} messages are cached locally for fast browsing. {total} total on the mail server.')
      .replace('{cached}', data.total.toLocaleString()).replace('{total}', data.realTotal.toLocaleString());
    Dialog.alert(msg, { title: I18n.t('Cached messages') });
  });
}

/* ---------- installed PWA: hardware/gesture back button ----------
 * An installed standalone PWA has no visible browser back button/toolbar —
 * the only way "back" exists at all is the OS-level hardware button
 * (Android) or edge-swipe gesture (iOS), which by default either closes
 * the app outright or falls through to whatever real page history happens
 * to exist. Neither is right for a single-page app. Trapped instead via
 * the History API so it always does exactly one of three things, in
 * priority order: close an open message (back to the list, wherever it
 * was scrolled to — see closeMessage), or leave a specific account's
 * folder view for "All inboxes," or — once there's nowhere left to
 * collapse — nothing at all, never falling through to actually exiting.
 * Scoped to standalone/installed mode (display-mode matchMedia, plus the
 * older iOS navigator.standalone) OR a mobile-width viewport — a phone's
 * hardware/gesture back button is expected to step through in-app state
 * either way, installed or a plain browser tab, since there's no other
 * "back" affordance visible on a phone screen at all. A DESKTOP browser tab
 * is deliberately excluded unless standalone: there the browser's own
 * back button already gives an obvious, expected way back to wherever the
 * user came from, and trapping that too would be actively hostile. */
function isStandalonePwa() {
  return matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
}
function shouldTrapBackNav() {
  return isStandalonePwa() || isMobileViewport();
}

/**
 * Reclaiming Android's bottom 3-button nav bar for an installed PWA used to
 * be attempted here via a JS-triggered Element.requestFullscreen() call on
 * the first tap — removed after it turned out to actively backfire on real
 * devices: entering fullscreen that way could get visibly "stuck" (an
 * Android toast confirming fullscreen, but the nav bar still showing, with
 * no way back out short of reinstalling). The actual, documented fix is
 * declarative: manifest.webmanifest's "display" is now "fullscreen" instead
 * of "standalone" — that's what Chrome/Android honors for hiding the nav
 * bar on an installed PWA; a bare "standalone" declaration keeps more
 * system chrome around regardless of anything this page's own JS does.
 * Nothing else needed here — see manifest.webmanifest, the safe-area
 * handling right below (env(safe-area-inset-*)'s reliability is a related
 * but separate concern from nav-bar visibility), and, for the native
 * Android app shell (a separate project), its own WindowInsetsController-
 * based immersive mode, which doesn't share any of the web Fullscreen
 * API's unreliability since it controls system UI directly.
 */
/** Adds one history entry for hardware back to land on — every "deeper"
 * transition (opening a message, leaving "All inboxes" for a specific
 * account) calls this once. No-op outside a trapped context (see
 * shouldTrapBackNav). */
function navPush() {
  if (!shouldTrapBackNav()) return;
  history.pushState({ hmelj: true }, '', location.href);
}
/** Collapses exactly one level right now, whichever applies — returns
 * whether it actually did anything, so the popstate listener below knows
 * whether to re-arm the trap (nothing left to collapse, i.e. this press
 * would otherwise have fallen through to exiting) or leave things alone
 * (the entry the browser just landed on is already the correct trap for
 * the level above — see navPush's own call at that level). A single-
 * account setup never shows "All inboxes" as a real destination at all
 * (see renderAccounts), so its one folder view is treated as the floor too
 * — same as literal root would be for a multi-account one. */
function navCollapseOneLevel() {
  // Levels are checked outermost-first — literally in front-to-back screen
  // order — so each press dismisses whatever is actually on top and leaves
  // everything it was covering exactly where it was.
  //  1. A Dialog.* confirm/prompt (dismissed as a cancel — never as an
  //     implicit OK, so back can't confirm a delete no one meant to confirm).
  //     Also covers compose's own close prompt, which is why compose sits
  //     below this: back opens that prompt, and back again cancels it.
  if (Dialog.cancelTop()) return true;
  //  1b. The theme picker — same look as a Dialog.* one, but built by hand
  //     (see showThemePicker), so Dialog's own stack doesn't know about it.
  //     It has no "apply" step to abandon: every swatch/color change is
  //     already saved and live, so back just dismisses it, same as its Close
  //     button.
  if ($('#theme-picker-backdrop')) { closeThemePicker(); return true; }
  //  2. The attachment viewer's full-screen overlay.
  if (AttachmentViewer.isOpen()) { AttachmentViewer.close(); return true; }
  //  3. Compose — via requestClose(), the same save/delete/cancel decision
  //     the X button and Escape go through, so a back press can never throw
  //     away an unsaved draft silently. A minimized compose deliberately
  //     isn't a level (see Compose.isOpen).
  if (Compose.isOpen()) { Compose.requestClose(); return true; }
  //  4. Settings — its own inner levels first (the Filters tab's editor
  //     collapses back to the filter list), then closes without saving, same
  //     as its own X button.
  if (Settings.isOpen()) { if (!Settings.collapseOneLevel()) Settings.close(); return true; }
  //  4b. Mailbox analytics, likewise. A scan keeps running in the background
  //     if one is going; closing the page only stops watching it.
  if (Analytics.isOpen()) { Analytics.close(); return true; }
  //  5. The user-menu bottom sheet.
  if ($('#user-menu-backdrop').classList.contains('open')) { closeUserMenu(); return true; }
  //  6. The mobile sidebar. Guarded on the viewport because outside the
  //     mobile breakpoint the sidebar is permanently visible furniture, not
  //     an overlay anyone can back out of.
  if (isMobileViewport() && !$('#sidebar').classList.contains('collapsed')) { setSidebarOpen(false); return true; }
  //  7. …then in-page navigation proper.
  if (state.openUid) { closeMessage(); return true; }
  if (state.currentAccount !== 'all' && activeAccounts().length > 1) { switchAccount('all'); return true; }
  return false;
}
window.addEventListener('popstate', () => {
  if (!shouldTrapBackNav()) return;
  if (!navCollapseOneLevel()) navPush();
});

/**
 * Escape dismisses the topmost overlay — the keyboard's version of the back
 * key, and the same front-to-back order navCollapseOneLevel documents.
 *
 * Only the OVERLAY levels, deliberately: Escape stops at the last dialog and
 * does not carry on into in-page navigation the way back does. Closing the
 * message you are reading is arguable; switching account back to All inboxes,
 * which is where that chain ends, plainly is not what Escape means.
 *
 * Everything above Settings owns its own Escape already (Dialog, the theme
 * picker, the attachment viewer, compose — each with its own close semantics,
 * compose's being a save/discard prompt rather than a dismissal). This checks
 * for them and stands aside rather than closing two layers on one press. The
 * dialog case is also guarded at the source now — see dialog.js — since its
 * backdrop is gone by the time a bubbled event reaches here.
 */
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || e.defaultPrevented) return;
  if ($('.dialog-backdrop') || $('#theme-picker-backdrop')) return;
  if (AttachmentViewer.isOpen() || Compose.isOpen()) return;
  //  Settings collapses its inner levels first (the Filters tab's editor back
  //  to the filter list), exactly as the back key does.
  if (Settings.isOpen()) { if (!Settings.collapseOneLevel()) Settings.close(); return; }
  if (Analytics.isOpen()) { Analytics.close(); }
});

/** Native Android app shell's hardware back button hook (a separate project —
 * see its own MainActivity.kt's onBackCallback). isStandalonePwa() (display-mode:
 * standalone / navigator.standalone) never matches inside that app's own plain
 * WebView — it has no browser-driven "installed" concept at all — so the
 * pushState/popstate trap above never engages there. This exposes the same
 * underlying per-level collapse directly, sidestepping the whole push/pop
 * history mechanism (which isn't needed here — native calls this once per
 * hardware back press and acts on the true/false result itself), so whatever
 * overlay is on top closes first (dialog → attachment viewer → compose →
 * Settings → user menu → sidebar), then a message open closes to the list,
 * then a specific account backs out to "All inbox", exactly like the PWA trap
 * above, before native's own change-server flow ever takes over — in
 * particular its double-press "press back again to leave" hint can no longer
 * appear while something is still open on top of the list.
 * No-op / undefined in a real browser tab or PWA. */
window.__hmeljHandleBack = () => navCollapseOneLevel();
// Pre-rename name, still called by an APK built before Hmail became Hmelj.
window.__hmailHandleBack = window.__hmeljHandleBack;

/* ---------- message view ---------- */
let mobileListScroll = 0;
function isMobileViewport() { return matchMedia('(max-width: 900px)').matches; }

/** Sidebar as a mobile overlay: hamburger opens it (with a dim backdrop),
 * tapping the backdrop or picking an account/folder closes it again. */
function setSidebarOpen(open) {
  $('#sidebar').classList.toggle('collapsed', !open);
  // Mirrors #sidebar's own toggle exactly (just `open`, no separate
  // isMobileViewport() re-check) — CSS alone already fully suppresses
  // .sidebar-backdrop outside the mobile breakpoint (unconditional
  // `display:none`, only overridden inside the mobile media query), so an
  // extra JS-side viewport check here was redundant and could disagree with
  // the CSS media query for a moment (e.g. a resize landing mid-tap),
  // leaving the sidebar visibly open with no backdrop to catch an
  // outside-tap and close it again.
  $('#sidebar-backdrop').hidden = !open;
}
function closeSidebarIfMobile() {
  if (isMobileViewport()) setSidebarOpen(false);
}

/** User menu: a bottom sheet holding everything that used to live in the top
 * bar (theme/settings/logout) plus the old sidebar-footer links. Toggled via
 * a class (not [hidden]) so the slide-up transform can actually transition. */
function openUserMenu() { $('#user-menu-backdrop').classList.add('open'); }
function closeUserMenu() { $('#user-menu-backdrop').classList.remove('open'); }

function closeMessage() {
  clearMarkReadTimers();
  // The find bar belongs to the frame it was searching — and that frame is
  // about to be gone.
  MessageFind.close();
  const hadOpen = state.openUid !== null;
  state.openUid = null;
  $('#message-view').hidden = true;
  $('#empty-state').hidden = false;
  if (isMobileViewport()) {
    $('#content').classList.remove('mobile-show-message');
    const list = $('#msg-list');
    requestAnimationFrame(() => { list.scrollTop = mobileListScroll; });
  }
  // Drop the "selected" highlight from whichever row was open — otherwise
  // it stays marked (buildRow keys it off state.openUid) even after the
  // mobile back button returns to the list, well past the point it means
  // anything. Callers that immediately reload the list anyway (loadMessages/
  // reconcileMessages) will just render again on top of this harmlessly.
  if (hadOpen) renderList();
}

async function openMessage(m) {
  const s = state.settings;
  const msgFolder = m.folder || state.currentFolder;
  const msgAccount = m.account?.id || (state.currentAccount !== 'all' ? state.currentAccount : null);
  if (s.readingPane === 'window') {
    window.open(`/message.html#${encodeURIComponent(msgFolder)}/${encodeURIComponent(m.uid)}/${encodeURIComponent(msgAccount || '')}`, '_blank', 'width=860,height=720');
    scheduleMarkRead(m);
    return;
  }
  if (s.readingPane === 'off') {
    window.location.hash = `#msg/${encodeURIComponent(msgFolder)}/${encodeURIComponent(m.uid)}`;
  }
  navPush(); // hardware back closes this message instead of exiting — see the block above closeMessage()
  clearMarkReadTimers(); // whatever was open is being replaced — it no longer counts as "read for long enough"
  state.openUid = m.uid;
  renderList();
  const view = $('#message-view');
  $('#empty-state').hidden = true;
  view.hidden = false;
  // Mobile: switch from list to a full-screen message view (back button
  // returns to the list, restoring exactly where it was scrolled to).
  if (isMobileViewport()) {
    mobileListScroll = $('#msg-list').scrollTop;
    $('#content').classList.add('mobile-show-message');
  }
  // mv-placeholder makes the view fill the pane and centre its one child, the
  // way .empty-state next to it already does — a transient one-liner pinned to
  // the top-left corner of an otherwise empty pane reads as a rendering glitch.
  // Dropped again the moment renderMessage() puts real content here.
  view.classList.add('mv-placeholder');
  MessageFind.close(); // searching the message that was here, not the one arriving
  view.innerHTML = '<p style="color:var(--text-dim)">Loading message…</p>';
  // A conversation row opens as the whole conversation. Anything that isn't one
  // — a live (uncached) listing, a notification deep link, conversation view
  // simply being off — carries no thread count and falls straight through.
  if (isThreadRow(m)) return openThread(m);
  await showSingleMessage(view, m);
}

/** Fetches one message and renders it into the pane.
 *
 * The tail of openMessage, split out so openThread can fall back to it — a row
 * whose conversation turns out to hold one message after all — without
 * re-running the preamble above (which would push a second history entry and
 * re-do the mobile list/message switch). */
/**
 * Which account a list entry belongs to.
 *
 * `entry.account` only exists in the unified view, where a row has to say which
 * mailbox it came from; browsing one account's folder there is nothing to say,
 * so the answer is the account being browsed. Every fetch got this right by
 * accident — API._acct falls back to the ambient account when none is passed —
 * but `__account` is also what the attachment chip's href is built from, and a
 * hand-built URL has no such fallback: opening a CONVERSATION inside a single
 * account produced attachment links with no `?account=` at all, which the
 * server refuses with "No mail account selected". The attachment never
 * appeared, and before the viewer reported HTTP errors it did that silently,
 * as a black rectangle that looked like a slow load.
 */
function accountOf(entry) {
  return entry?.account?.id || (state.currentAccount !== 'all' ? state.currentAccount : null);
}

/**
 * What the reading pane shows for a message this device didn't save.
 *
 * It still knows who it is from, what it is about and when it arrived — that
 * came from the list, which IS cached — so the card shows all three rather than
 * a bare apology. What is missing is only the body, and saying exactly that (and
 * exactly why) is the difference between a limit and a fault.
 */
function offlineMessageCardHtml(m) {
  const from = m.from?.name || m.from?.address || I18n.t('(unknown)');
  return `<div class="mv-offline">
    <div class="mv-offline-icon">📭</div>
    <h2 data-no-i18n>${esc(m.subject || I18n.t('(no subject)'))}</h2>
    <p class="mv-offline-meta" data-no-i18n>${esc(from)} · ${esc(fmtDate(m.date, { long: true }))}</p>
    <p>${esc(I18n.t('This message isn’t saved on this device, so it can’t be opened while offline. It will open normally once the connection is back.'))}</p>
    <p class="mv-offline-hint">${esc(I18n.t('Settings › Offline sets how much mail is kept for offline reading.'))}</p>
  </div>`;
}

async function showSingleMessage(view, m, { allowImages = false } = {}) {
  const msgFolder = m.folder || state.currentFolder;
  const msgAccount = accountOf(m);
  let msg;
  try {
    msg = await withMsgCtx(m, (folder, acct) => API.message(folder, m.uid, allowImages, acct));
  } catch (e) {
    // 410: the server says this message is gone — moved, deleted, or (a meeting
    // invitation) consumed by answering it. It has already dropped its own
    // cached row, so the only thing left is to take the row off the screen
    // instead of leaving one that fails every time it is clicked.
    if (e.status === 410) {
      dropMessageRow(m);
      toast(e.message, 5000);
      return;
    }
    // Offline, and this particular message's body was never saved on this
    // device — the prefetcher had not reached it, or it was evicted to stay
    // under the size cap. That is not an error, it is a fact about this
    // device's cache, and it has a specific remedy: read it when the
    // connection is back, or keep more mail offline.
    if (e?.offline) {
      view.classList.remove('mv-placeholder');
      view.innerHTML = offlineMessageCardHtml(m);
      return;
    }
    view.innerHTML = `<p style="color:var(--danger)">Error: ${esc(e.message)}</p>`;
    return;
  }
  if (state.openUid !== m.uid) return; // something else was opened while this was in flight
  view.classList.remove('mv-placeholder');
  msg.__folder = msgFolder;
  msg.__account = msgAccount;
  // Kept for the keyboard shortcuts: r/a/f need the FETCHED message (body,
  // headers, attachments), not the envelope the list row carries.
  state.openMessage = msg;
  // A draft is not a message to read — it is something you are still writing,
  // and the composer is where it belongs. It used to be drawn as an ordinary
  // message AS WELL, which meant two copies of it on screen saying different
  // things, and a stale one left behind in the reading pane after the draft
  // was discarded. The row's own account, not the current one, because
  // `state.currentAccount` is 'all' in the unified view.
  const rowAccount = state.accounts.find((x) => x.id === msgAccount);
  if (rowAccount && msgFolder === rowAccount.draftsFolder) {
    Compose.editDraft(msg);
    state.openMessage = null;
    closeMessage(); // nothing is open in the pane, so nothing may claim to be
    return;
  }
  renderMessage(view, msg, m);
  scheduleMarkRead(m);
}

/** Drops every pending auto-mark-as-read. Called wherever the messages those
 *  timers belong to stop being on screen — closing the pane, or opening
 *  something else in it — since "you had it open long enough" stops being true
 *  the moment it isn't open any more. */
function clearMarkReadTimers() {
  for (const t of state.markReadTimers.values()) clearTimeout(t);
  state.markReadTimers.clear();
}

function scheduleMarkRead(m) {
  const key = String(m.uid);
  clearTimeout(state.markReadTimers.get(key));
  const s = state.settings;
  if (m.seen || s.autoMarkRead === 'never' || s.autoMarkRead === 'manual') return;
  const delay = s.autoMarkRead === 'immediate' ? 0 : (s.autoMarkReadDelay || 0) * 1000;
  state.markReadTimers.set(key, setTimeout(async () => {
    state.markReadTimers.delete(key);
    // Optimistic, like every other mark-read path (quickToggleRead): flip the
    // row and nudge the badges first, then confirm. This one used to skip
    // adjustUnreadCounts entirely and reach for the heavyweight loadFolders()
    // instead, so opening a message left every unread badge stale until that
    // round trip (a full per-account fan-out in the unified view) came back.
    try {
      await trackMutation(withMsgCtx(m, (folder, acct) => API.flags(folder, [m.uid], ['\\Seen'], [], acct)));
    } catch (e) {
      // Previously uncaught inside the timer: an unhandled rejection, no
      // toast, and the message silently left unread.
      toast('Mark as read failed: ' + e.message);
      return;
    }
    m.seen = true;
    noteMemberRead(m, true); // if this message is part of a conversation row, that row's count moves too
    adjustUnreadCounts(m, -1);
    renderList();
    scheduleReconcile(2); // true up against the server without rebuilding the tree
  }, delay));
}

function initials(nameOrAddr) {
  const s = (nameOrAddr || '?').trim();
  return s[0]?.toUpperCase() || '?';
}

/** 1-2 character badge for an account's chip: first character of each of the
 * first two words if the label is multi-word ("Personal Gmail" -> "PG"),
 * otherwise the first two characters of a single word ("Work" -> "WO").
 *
 * Punctuation and symbols are dropped first, so "T-2" badges as "T2" rather
 * than spending half of a two-character badge on a hyphen — same for a label
 * that leads with an emoji or a bullet. Letters and digits are matched by
 * Unicode property (\p{L}/\p{N}), not A-Z0-9, so "Šola" keeps its Š; and the
 * characters are taken from a spread array rather than by index, so a label
 * made of astral-plane characters can't be cut through the middle of a
 * surrogate pair. */
function acctInitials(label) {
  const words = (label || '').split(/\s+/)
    .map((w) => w.replace(/[^\p{L}\p{N}]/gu, ''))
    .filter(Boolean);
  if (words.length >= 2) return ([...words[0]][0] + [...words[1]][0]).toUpperCase();
  return ([...(words[0] || '?')].slice(0, 2).join('')).toUpperCase();
}

/**
 * What an unsubscribe actually did, in a sentence.
 *
 * The old banner said "Unsubscribe request sent (0rhmo.mjt.lu)" for all three
 * kinds, which left the obvious questions unanswered: sent how, to whom, and
 * did it work? Each method knows something different and says it:
 *
 *  - post — the server POSTed RFC 8058's one-click form to the sender's own
 *    unsubscribe URL, and the sender's server ANSWERED. Any non-2xx is an error
 *    the caller never gets here with, so the status IS the confirmation.
 *  - mail — an unsubscribe message really was sent, from a real address of
 *    yours, which is worth naming: it is what the list manager matches on.
 *  - open — a page was opened for you to finish. Nothing here knows whether you
 *    did, which is why this one never says "unsubscribed" (see unsubSaid).
 */
function unsubHow(r) {
  const target = esc(r?.target || '');
  if (r?.method === 'post') {
    return `${esc(I18n.t('one-click request accepted by'))} ${target}`
      + (r.status ? ` (HTTP ${esc(String(r.status))})` : '');
  }
  if (r?.method === 'mail') {
    return `${esc(I18n.t('unsubscribe e-mail sent to'))} ${target}`
      + (r.from ? ` · ${esc(I18n.t('sent from'))} ${esc(r.from)}` : '');
  }
  return `${esc(I18n.t('unsubscribe page opened'))} — ${esc(I18n.t('finish it in your browser'))}`;
}

/**
 * The banner's whole line. `when` is set for something that happened on an
 * earlier visit (the stored record), absent for what just happened.
 *
 * 'open' deliberately never claims you unsubscribed — a page was opened, and
 * whether anything came of it happened outside this app entirely.
 */
function unsubSaid(r, when) {
  if (r?.method === 'open') {
    return when ? `${esc(fmtDate(when, { long: false }))} — ${unsubHow(r)}` : unsubHow(r);
  }
  return `${esc(I18n.t('Unsubscribed'))}${when ? ' ' + esc(fmtDate(when, { long: false })) : ''} — ${unsubHow(r)}`;
}

/**
 * Corrects a conversation row's count from what opening it actually found.
 *
 * The chip is drawn once and only repainted when a reconcile happens to run;
 * the stack is fetched fresh at the moment of the click. Between the two, a
 * conversation that grew — a reply landing while the list sat on screen — shows
 * its old number until the next silent refresh. Reported as "the list says 2
 * and the pane shows 4", and both were right when they were computed.
 *
 * Opening a conversation is the one moment the true count is known for free, so
 * the row learns it then instead of waiting. Only the count: `threadUids` still
 * means "the messages in the folder you are looking at", which is what every
 * action on the row is allowed to touch, and the stack may legitimately span
 * more than that.
 */
function correctThreadCount(row, count) {
  if (!row || !count || row.threadCount === count) return;
  row.threadCount = count;
  const chip = $(`#msg-list > li[data-uid="${CSS.escape(String(row.uid))}"] .m-thread`);
  if (chip) chip.textContent = count;
}

/**
 * Takes one message out of the list and the reading pane, for a message that is
 * gone from the SERVER rather than from a decision made here.
 *
 * Two things reach this: answering a meeting invitation (both Exchange and
 * Graph file the handled request away), and opening a message that has since
 * been moved or deleted elsewhere. Deliberately no undo — nothing here did it,
 * so there is nothing to take back.
 */
function dropMessageRow(entry) {
  const idx = state.messages.findIndex((m) => m === entry || m.uid === entry?.uid);
  if (idx !== -1) {
    const m = state.messages[idx];
    const unread = m.threadUids ? (m.threadUnseen || 0) : (m.seen ? 0 : 1);
    if (unread) adjustUnreadCounts(m, -unread);
    state.messages.splice(idx, 1);
    renderList();
  }
  if (!dropOpenCard(entry) && state.openUid === entry?.uid) closeMessage();
}

/* ---------- meeting invitations ---------- */

/**
 * The "when" line of an invitation.
 *
 * `floating` means the sender named a wall-clock time in a zone nothing could
 * resolve (Exchange writes Windows zone names — see server/icalendar.js). The
 * time is then shown exactly as written with the zone named beside it, rather
 * than converted on a guess: a meeting silently moved by an hour is far worse
 * than one that says which clock it is on.
 */
function inviteWhen(inv) {
  const s = inv.start, e = inv.end;
  if (!s) return '';
  if (inv.allDay) {
    const from = fmtDate(s.iso, { long: false });
    return e && e.iso !== s.iso ? `${from} – ${fmtDate(e.iso, { long: false })}` : from;
  }
  if (s.floating) {
    const t = (x) => String(x.iso).replace('T', ' ').slice(0, 16);
    return `${t(s)}${e ? ' – ' + t(e).slice(11) : ''}${s.zone ? ` (${s.zone})` : ''}`;
  }
  const from = fmtDate(s.iso, { long: true });
  if (!e) return from;
  // Same day: the end needs only its time, which is how anyone reads a meeting.
  const sameDay = new Date(s.iso).toDateString() === new Date(e.iso).toDateString();
  return `${from} – ${sameDay ? fmtDate(e.iso, { long: false }).split(' ').pop() : fmtDate(e.iso, { long: true })}`;
}

/** What kind of calendar message this is, in a word. */
function inviteKind(inv) {
  if (inv.method === 'CANCEL' || inv.status === 'CANCELLED') return I18n.t('Meeting cancelled');
  if (inv.method === 'REPLY') return I18n.t('Reply to your invitation');
  if (inv.method === 'REQUEST') return I18n.t('Meeting invitation');
  return I18n.t('Calendar event');
}

/**
 * The invitation card, above the message body.
 *
 * Deliberately its own block rather than a `.mv-banner`: an invitation's when
 * and where ARE the message — the body under it is usually a rendering of the
 * same thing plus a joining link — so this is content, not a notice.
 */
function invitationHtml(msg) {
  const inv = msg.invitation;
  if (!inv) return '';
  const rows = [];
  const when = inviteWhen(inv);
  if (when) rows.push([I18n.t('When'), esc(when) + (inv.recurrence ? ` <span class="mv-inv-repeat">${esc(I18n.t('repeats'))}</span>` : '')]);
  if (inv.location) rows.push([I18n.t('Where'), esc(inv.location)]);
  if (inv.organizer) rows.push([I18n.t('Organizer'), addrChip(inv.organizer)]);
  if (inv.attendees.length) {
    // Everyone, but the count first: a 30-person invitation should say 30
    // rather than filling the pane before the message starts.
    const list = inv.attendees.map((a) => addrChip(a)).join(', ');
    rows.push([`${I18n.t('Attendees')} (${inv.attendees.length})`, `<span class="mv-inv-people">${list}</span>`]);
  }
  const cancelled = inv.method === 'CANCEL' || inv.status === 'CANCELLED';
  const actionable = inv.method === 'REQUEST' && !cancelled;
  return `<div class="mv-invite${cancelled ? ' mv-invite-cancelled' : ''}">
    <div class="mv-inv-kind">📅 ${esc(inviteKind(inv))}${inv.summary && inv.summary !== msg.subject ? ' — ' + esc(inv.summary) : ''}</div>
    <dl class="mv-inv-grid">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('')}</dl>
    ${actionable ? `<div class="mv-inv-actions">
      <button class="btn-sm mv-inv-btn" data-action="accept">${esc(I18n.t('Accept'))}</button>
      <button class="btn-sm mv-inv-btn" data-action="tentative">${esc(I18n.t('Maybe'))}</button>
      <button class="btn-sm mv-inv-btn" data-action="decline">${esc(I18n.t('Decline'))}</button>
    </div>` : ''}
  </div>`;
}

const INVITE_VERB = {
  accept: { title: 'Accept', done: 'Accepted' },
  tentative: { title: 'Maybe', done: 'Answered “maybe”' },
  decline: { title: 'Decline', done: 'Declined' },
};

/**
 * Wires the three buttons.
 *
 * Each opens the same three choices Outlook offers, because answering an
 * invitation is really two decisions and only one of them is the verb:
 *
 *   Send the response now      — the plain answer, organizer told
 *   Edit the response first    — the same, after you have written something
 *   Do not send a response     — recorded for you, organizer told nothing
 *
 * The third is the one that needed the backend to change: it is Graph's
 * `sendResponse:false`, and on Exchange the same CreateItem with
 * MessageDisposition="SaveOnly". An earlier version of this offered only the
 * first two and quietly mailed the organizer every time, which is exactly the
 * choice somebody may not want to make.
 */
function bindInvitation(card, listEntry) {
  const box = $('.mv-invite', card);
  if (!box) return;

  const answer = async (action, { comment = '', sendResponse = true }) => {
    const verb = INVITE_VERB[action];
    $$('.mv-inv-btn', box).forEach((b) => { b.disabled = true; });
    try {
      const r = await trackMutation(withMsgCtx(listEntry, (folder, acct) =>
        API.respondToInvitation(folder, listEntry.uid, action, comment, sendResponse, acct)));
      const said = `${I18n.t(verb.done)} — ${I18n.t(r.sent === false ? 'no response sent' : 'the organizer has been told')}`;
      toast(said);
      if (r.consumed) {
        // Exchange and Graph file a handled invitation away by default, so the
        // message this card is showing no longer exists. Taking the row out
        // here rather than waiting for a sync is what stops the next click
        // landing on "the specified object was not found in the store".
        dropMessageRow(listEntry);
      } else {
        // Still in the mailbox (the "keep answered requests" mailbox setting).
        // Replaced rather than left alone: the buttons would now be a lie.
        box.innerHTML = `<div class="mv-inv-kind">📅 ${esc(said)}</div>`;
      }
      scheduleReconcile();
      loadFolders();
    } catch (e) {
      $$('.mv-inv-btn', box).forEach((b) => { b.disabled = false; });
      toast('Could not answer the invitation: ' + e.message, 5000);
    }
  };

  const editThenAnswer = async (action) => {
    const typed = await Dialog.form(I18n.t(INVITE_VERB[action].title),
      `<label class="dialog-label">${esc(I18n.t('Message to the organizer (optional)'))}</label>
       <textarea class="dialog-input" id="inv-comment" rows="4"></textarea>`,
      { okLabel: I18n.t('Send'), getValue: (root) => root.querySelector('#inv-comment').value });
    if (typed === null || typed === undefined) return; // cancelled — nothing is sent
    answer(action, { comment: typed });
  };

  // The menu opens under the button that was pressed, the way the ⋯ menu does.
  $$('.mv-inv-btn', box).forEach((btn) => btn.addEventListener('click', (e) => {
    const action = btn.dataset.action;
    const r = e.currentTarget.getBoundingClientRect();
    openCtxMenu([
      { label: 'Send the response now', onClick: () => answer(action, {}) },
      { label: 'Edit the response first', onClick: () => editThenAnswer(action) },
      { label: 'Do not send a response', onClick: () => answer(action, { sendResponse: false }) },
    ], r.left, r.bottom + 4);
  }));
}

/* ---------- addresses in a message header ---------- */

/**
 * One person in a message header, as markup you can act on.
 *
 * Always name AND address when both are known, which the To line did not do —
 * it printed `name || address`, so a recipient with a display name showed as
 * "NOC Services" and its address appeared nowhere in the app at all. (Cc showed
 * the bare address instead, so the same header disagreed with itself.)
 *
 * The right-click / long-press menu is on the chip (bindAddressMenu below);
 * everything it needs is in the data attributes, so the handler is bound once
 * per card rather than once per address.
 */
function addrChip(p) {
  const address = p?.address || '';
  const name = p?.name || '';
  if (!address && !name) return '';
  const label = name && address
    ? `${esc(name)} <span class="mv-addr-email">&lt;${esc(address)}&gt;</span>`
    : esc(name || address);
  if (!address) return `<span class="mv-addr-plain">${label}</span>`;
  return `<span class="mv-addr" data-address="${escAttr(address)}" data-name="${escAttr(name)}"
    title="${escAttr(I18n.t('Right-click (or long-press) for options'))}">${label}</span>`;
}

const addrList = (people) => (people || []).map(addrChip).filter(Boolean).join(', ');

/** What one address offers: copying it, and writing to it. */
/* ---------- sender authentication (server/authResults.js) ----------
 * Whether the message really came from where its From line claims. This is the
 * one piece of evidence that speaks to the thing most mail actually gets used
 * to do harm with — impersonation — and unlike a signature it is already in
 * essentially every message, because the receiving server put it there.
 */

/** The chip beside the sender. Structurally the same as the priority span next
 *  to it: one inline element, no layout of its own, and it folds away with the
 *  header for free. Nothing at all for the ordinary cases, because a badge on
 *  every message is a badge nobody reads — only a pass worth stating and a
 *  failure worth stopping at. */
function authChip(msg) {
  if (state.settings.senderAuthBadge === false) return '';
  const a = msg?.headers?.auth;
  if (!a) return '';
  const detail = [
    a.spf ? `SPF: ${a.spf}` : '', a.dkim ? `DKIM: ${a.dkim}` : '', a.dmarc ? `DMARC: ${a.dmarc}` : '',
    a.dkimDomain ? I18n.t('signed by') + ' ' + a.dkimDomain : '',
  ].filter(Boolean).join(' · ');
  if (a.verdict === 'fail') {
    return `<span class="mv-auth mv-auth-fail" title="${escAttr(detail)}">⚠ ${esc(I18n.t('Failed sender checks'))}</span>`;
  }
  if (a.verdict === 'pass') {
    return `<span class="mv-auth mv-auth-pass" title="${escAttr(detail)}">🔒 ${esc(I18n.t('Verified sender'))}</span>`;
  }
  // 'partial' and 'none' get nothing. A mailing list breaks SPF by design and a
  // server that checks nothing is the default on plenty of small hosts; marking
  // either as suspect would put a warning on ordinary mail, which is how people
  // learn to ignore warnings.
  return '';
}

/**
 * The banner, for the two cases worth interrupting a reader over.
 *
 * A DMARC failure means the message claims a From domain it is not authorised
 * to use. A spoofed display name means it wears the name of someone in the
 * address book over an address that is not theirs — which passes every
 * authentication check there is, because the domain it really came from did
 * authorise it. The second is the one that actually catches people.
 */
function authBanner(msg) {
  if (state.settings.senderAuthBadge === false) return '';
  const a = msg?.headers?.auth;
  const from = msg?.from?.[0];
  let out = '';
  if (a?.verdict === 'fail') {
    out += `<div class="mv-banner mv-banner-danger">⚠ <b>${esc(I18n.t('This message failed its sender checks.'))}</b>
      ${esc(I18n.t('It claims to be from a domain it is not authorised to send for. Treat links and attachments in it as untrusted.'))}</div>`;
  }
  const impersonated = from && authSpoofCheck(from);
  if (impersonated) {
    // Tagged with the address it is about: adding that address to the contacts
    // is what answers this banner, and addAddressToContacts removes it on the
    // spot rather than leaving a warning up that is no longer true.
    out += `<div class="mv-banner mv-banner-danger mv-banner-spoof" data-addr="${escAttr(from.address || '')}">⚠ <b>${esc(I18n.t('The sender\'s name does not match their address.'))}</b>
      ${esc(I18n.t('You know this name as {addr} — this message came from somewhere else.').replace('{addr}', impersonated))}</div>`;
  }
  return out;
}

/** Client-side twin of authResults.js#spoofedDisplayName, over the contacts
 *  already loaded here. Kept deliberately conservative in the same way: a name
 *  under four characters, or one that is itself an address, is skipped, because
 *  a false alarm is what teaches people to click past the real one. */
function authSpoofCheck(from) {
  const shown = String(from.name || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const addr = String(from.address || '').trim().toLowerCase();
  if (shown.length < 4 || !addr || shown.includes('@')) return null;
  // Never accuse the user of impersonating themselves. Anyone with two
  // addresses under one name — a work account and a private one, which is the
  // normal case here — sees their OWN sent mail flagged otherwise, and a
  // warning that fires on your own reply is worse than no warning at all.
  if (isOwnAddress(addr)) return null;
  // Every address the address book knows this name at, not just the first one.
  // A contact ROW is one name + one address (server/contacts.js), so a person
  // with two addresses is two rows: stopping at the first mismatch reports a
  // spoof for the second address of somebody perfectly legitimate.
  const known = [];
  for (const c of state.contacts || []) {
    const cname = String(c?.name || '').trim().toLowerCase().replace(/\s+/g, ' ');
    const cmail = String(c?.email || '').trim().toLowerCase();
    if (!cname || !cmail || cname !== shown) continue;
    if (cmail === addr) return null; // known at this very address — nothing to say
    known.push(cmail);
  }
  return known.length ? known[0] : null;
}

/* ---------- turning a message into an event ---------- */

/** Whether anything could receive one. Refreshed by the calendar view whenever
 *  it loads, so the menu entry appears as soon as a calendar is added rather
 *  than at the next reload. */
let writableCalendarCount = 0;
const hasWritableCalendar = () => writableCalendarCount > 0;
window.__hmeljSetWritableCalendars = (n) => { writableCalendarCount = n; };

/**
 * Opens the event editor prefilled from a message.
 *
 * The subject becomes the title and the body becomes the notes, both trimmed —
 * a whole newsletter pasted into an event's description is not what anybody
 * meant by "add this to my calendar". Everyone the message was addressed to is
 * offered as an attendee, since a meeting proposed by mail usually involves
 * exactly those people; they are only prefilled, and are removable before Save.
 */
function eventFromMessage(msg) {
  const text = String(msg.text || '').replace(/\r/g, '').trim();
  const people = [
    ...(msg.from ? [msg.from] : []),
    ...(msg.to || []),
  ].map((p) => ({ name: p.name || '', address: p.address || '' }))
    .filter((p) => p.address && !isOwnAddress(p.address));
  Calendar.createFrom({
    summary: msg.subject || '',
    // 2000 characters is a long note and a short email. Past that it is being
    // stored rather than read.
    description: text.length > 2000 ? text.slice(0, 2000) + '…' : text,
    attendees: people,
  });
}

/** Is this one of the user's own addresses? Inviting yourself to your own
 *  meeting is the sort of thing that looks like a bug to everyone who sees it. */
function isOwnAddress(address) {
  const a = String(address).toLowerCase();
  return (state.identities || []).some((i) => String(i.email || '').toLowerCase() === a)
    || (state.accounts || []).some((x) => String(x.email || '').toLowerCase() === a);
}

function showAddressMenu(el, x, y) {
  const address = el.dataset.address;
  if (!address) return;
  const name = el.dataset.name || '';
  openCtxMenu([
    { label: 'Copy address', onClick: () => copyAddress(address) },
    // The display name rides along when there is one, so the composer shows
    // "Support Desk <support@example.com>" the way it would for a contact.
    { label: 'New message', onClick: () => Compose.open({ to: name ? `${name} <${address}>` : address }) },
    addToContactsItem(address, name),
  ], x, y);
}

/**
 * The third entry: this person, in the address book, from where you are
 * reading their mail.
 *
 * It is deliberately a note rather than a missing row in the two cases where
 * there is nothing to do — see openCtxMenu on why. "Already in contacts" is
 * the answer to the question the user came to the menu with; leaving the row
 * out entirely just makes them wonder whether they mis-clicked.
 */
function addToContactsItem(address, name) {
  const addr = address.toLowerCase();
  if (isOwnAddress(addr)) return { label: 'This is your own address', disabled: true };
  const known = (state.contacts || []).some((c) => String(c?.email || '').trim().toLowerCase() === addr);
  if (known) return { label: 'Already in contacts', disabled: true };
  return { label: 'Add to contacts', onClick: () => addAddressToContacts(address, name) };
}

/**
 * Saves one address to the address book.
 *
 * The display name goes in exactly as the header spelled it, which matters
 * beyond tidiness: the spoofed-name warning (authSpoofCheck) compares the two
 * character for character, so a contact stored under a tidied-up name would
 * leave the warning firing on every message this person sends.
 *
 * Which is the other half of this — the warning on any message open right now
 * is answered the moment the contact exists, so it goes immediately rather
 * than standing there until the message is reopened. That case is the whole
 * reason for this menu entry: mail from a known person's second address is
 * flagged, and the fix should be one gesture away from the flag.
 *
 * De-duplication is the server's (addContacts in server/contacts.js, on the
 * lowercased address), so a second row for a name already in the book — a
 * colleague's work address next to their private one — is added, and the same
 * address twice is not.
 */
async function addAddressToContacts(address, name) {
  try {
    const { added } = await API.addContacts([{ name, email: address }]);
    // Not the local array with a row pushed onto it: the server assigns the id
    // and decides what counted as a duplicate, and compose's autocomplete reads
    // this same list.
    state.contacts = await API.contacts();
    if (!added) { toast(I18n.t('Already in contacts')); return; }
    const addr = address.toLowerCase();
    $$('.mv-banner-spoof').forEach((b) => {
      if ((b.dataset.addr || '').toLowerCase() === addr) b.remove();
    });
    toast(`${I18n.t('Added to contacts')}: ${name || address}`);
  } catch (e) {
    toast(I18n.t('Could not add contacts: ') + e.message, 5000);
  }
}

async function copyAddress(address) {
  try { await navigator.clipboard.writeText(address); toast(I18n.t('Copied')); }
  catch { toast('Could not copy to clipboard'); }
}

/**
 * Binds the address menu for a whole card at once — delegated, so it covers
 * every header line (From, To, Cc) and survives the header being rebuilt.
 *
 * Long-press for touch, because a phone has no right button. bindLongPress
 * fires on a timer; `user-select: none` on the chip (see app.css) is what stops
 * the browser's own text-selection handles racing it for the same gesture.
 */
function bindAddressMenu(card) {
  card.addEventListener('contextmenu', (e) => {
    const el = e.target.closest('.mv-addr');
    if (!el) return;
    e.preventDefault();
    showAddressMenu(el, e.clientX, e.clientY);
  });
  bindLongPress(card, (x, y) => {
    const el = document.elementFromPoint(x, y)?.closest?.('.mv-addr');
    if (el) showAddressMenu(el, x, y);
  });
}

/**
 * One message, rendered: header card, sandboxed body frame, attachments, and
 * every control that acts on that message.
 *
 * Returns an element rather than filling the reading pane, because with
 * conversation view on the pane holds SEVERAL of these at once (see
 * openThread). That is also why nothing in here uses an id — there is no such
 * thing as "the" body slot or "the" ⋯ button any more — and why the frame's
 * build options are parked on the element itself, for refreshOpenMessageTheme
 * to find when the theme changes under an open message.
 *
 * `listEntry` is the list row (or, inside a thread, that message's envelope
 * from the thread listing): the object flag changes are written back to, so
 * the list repaints without a round trip.
 *
 * `inThread` says this card is one of a stack rather than the whole reading
 * pane, which is the only thing that decides whether the quoted half of a
 * reply opens collapsed — see the quote block in messageFrame.js.
 */
function buildMessageCard(msg, listEntry, { collapsed = null, inThread = false } = {}) {
  const from = msg.from?.[0] || {};
  const fontFamily = migrateFontValue(state.settings.messageFont);
  const fontSize = state.settings.messageFontSize || 15;
  // Whether those two are FORCED over the message's own fonts — see
  // messageFrame.js#buildDoc and the setting's note in server/store.js.
  const fontOverride = !!state.settings.messageFontOverride;
  const prio = msg.priority && msg.priority !== 'normal'
    ? `<span class="${msg.priority === 'high' ? 'mv-priority-high' : ''}" title="Priority">${msg.priority === 'high' ? '❗ High priority' : '⬇ Low priority'}</span>` : '';
  const authed = authChip(msg);

  let banner = authBanner(msg);
  if (msg.blockedRemote > 0) {
    banner = `<div class="mv-banner">🖼 ${msg.blockedRemote} external image(s) blocked.
      <button class="link-btn mv-show-images">Show images</button>
      <button class="link-btn mv-trust-domain">Always trust ${esc(msg.senderDomain)}</button></div>`;
  }
  // A read receipt is never sent automatically or silently (see the route in
  // server/index.js for why) — the banner says who asked, and the button is the
  // only thing that sends it. $MDNSent is RFC 3503's "already answered" marker,
  // set by whichever client sent the receipt, this one included.
  // The address is flattened server-side (messageParse.js, and contentCache.js
  // for anything cached before that) — but this is the line that rendered
  // "[object Object]" at a user, so it does not trust that on its own.
  const receiptTo = typeof msg.headers?.dispositionNotificationTo === 'string'
    ? msg.headers.dispositionNotificationTo
    : (msg.headers?.dispositionNotificationTo?.value?.[0]?.address || msg.headers?.dispositionNotificationTo?.text || '');
  // Newsletters that publish a way out (RFC 2369/8058 — see server/unsubscribe.js).
  // Off-switch in Settings › Reading, because the OFFER is the decision: nothing
  // is sent without the button, but unsubscribing does tell a sender the address
  // is read, which on mail you never asked for is not always what you want.
  const unsub = state.settings.unsubscribeButton !== false ? msg.headers?.listUnsubscribe : null;
  if (unsub) {
    const what = unsub.source === 'body'
      // Said differently on purpose: the sender didn't publish a way out, this
      // is the most likely link in the message. Worth being honest about, since
      // it may land on a preferences page rather than a confirmation.
      ? I18n.t('Unsubscribe link found in this message')
      : unsub.method === 'open' ? I18n.t('Opens the sender\'s unsubscribe page')
        : unsub.method === 'mail' ? I18n.t('Sends an unsubscribe message') : I18n.t('Unsubscribes you in one step');
    // Compact by default (settings.unsubscribeBannerCompact): the icon and the
    // button, with the explanation folded away behind the icon. This banner
    // appears above the first line of every newsletter, so at a large UI scale
    // a full sentence of it costs more room than the message it introduces.
    const unsubMin = state.settings.unsubscribeBannerCompact !== false;
    // Already done once? Say so, with the date and where it went, instead of
    // offering the button as though nothing had happened — which is what it did
    // before: press Unsubscribe, open another message, come back, and the same
    // button was sitting there with no trace of the first press. Recorded per
    // SENDER, so every message from this newsletter says it (server/store.js).
    // The button stays, worded as a repeat: a sender that keeps mailing you is
    // exactly when you want to press it again.
    const already = msg.unsubscribed;
    const said = already
      ? unsubSaid(already, already.at)
      : `${esc(I18n.t('Newsletter'))} — ${esc(what)} (${esc(unsub.label || '')}).`;
    banner += `<div class="mv-banner mv-unsub-banner${unsubMin ? ' mv-unsub-min' : ''}${already ? ' mv-unsub-done' : ''}">
      <button class="mv-unsub-expand" title="${escAttr(I18n.t('Newsletter'))}" aria-expanded="${unsubMin ? 'false' : 'true'}">${already && already.method !== 'open' ? '✅' : '📭'}</button>
      <span class="mv-unsub-what">${said}</span>
      <button class="link-btn mv-unsubscribe">${esc(I18n.t(already ? 'Unsubscribe again' : 'Unsubscribe'))}</button></div>`;
  }
  if (receiptTo && !listEntry?.flags?.includes?.('$MDNSent') && !msg.flags?.includes?.('$MDNSent')) {
    banner += `<div class="mv-banner mv-receipt-banner">📬 ${esc(I18n.t('The sender asked to be told when you read this'))}
      (${esc(receiptTo)}).
      <button class="link-btn mv-send-receipt">${esc(I18n.t('Send receipt'))}</button></div>`;
  }

  const attach = msg.attachments.filter((a) => !a.inlineUsed);

  const toLine = 'To: ' + (addrList(msg.to) || esc('me')) +
    (msg.cc.length ? ' · Cc: ' + addrList(msg.cc) : '');
  // Name + address, not just the name — shown as one selectable line so the
  // address can be copied straight out of the header without opening a
  // separate dialog. Address-only senders (no display name) just show once,
  // not duplicated.
  const fromLine = addrChip(from);

  // The header's collapsed/expanded position is remembered across messages
  // (settings.messageHeaderCollapsed) — `collapsed` overrides it for the older
  // messages of a conversation, which always start collapsed no matter what.
  const startCollapsed = collapsed === null ? !!state.settings.messageHeaderCollapsed : collapsed;
  // The one-line summary that stands in for the full header block. Deliberately
  // still says who and when: those are the two things you scan a stack of
  // messages for, and the subject above it is the same on every card of a
  // conversation anyway.
  const brief = `${esc(from.name || from.address || '')} · ${esc(fmtDate(msg.date, { long: false }))}`;

  const card = document.createElement('article');
  card.className = 'mv-card';
  card.innerHTML = `
    <div class="mv-header-card${startCollapsed ? ' mv-head-collapsed' : ''}">
      <div class="mv-header-top">
        <h1 class="mv-subject">${esc(msg.subject)}</h1>
        <div class="mv-header-icons">
          <button class="icon-btn mv-star-btn ${listEntry?.flagged ? 'on' : ''}" title="Star">${listEntry?.flagged ? '★' : '☆'}</button>
          <button class="icon-btn mv-head-toggle" title="${escAttr(I18n.t(startCollapsed ? 'Show details' : 'Hide details'))}">${startCollapsed ? '▾' : '▴'}</button>
          <button class="icon-btn mv-more" title="More">⋯</button>
        </div>
      </div>
      <div class="mv-head-brief">${brief}</div>
      <div class="mv-from-line">${fromLine} ${prio} ${authed}</div>
      <div class="mv-date">${esc(fmtDate(msg.date, { long: true }))}</div>
      <div class="mv-to-line">${toLine}</div>
      ${answerNoteHtml(listEntry, msg)}
      ${banner}
    </div>
    ${invitationHtml(msg)}
    <div class="mv-body mv-body-slot"></div>
    ${attach.length ? `<div class="mv-attachments">${attach.map((a) =>
      `<a class="attach-chip" href="${escAttr(API.attachmentUrl(msg.__folder, msg.uid, a.index, msg.__account))}" data-filename="${escAttr(a.filename)}" data-content-type="${escAttr(a.contentType || '')}">📎 ${esc(a.filename)} <small>(${Math.round(a.size / 1024)} KB)</small></a>`).join('')}${
      // Only from two up: offering to bundle a single file is a longer way of
      // doing what the chip beside it already does. `download` and a plain
      // href, so this is the browser's own download rather than something this
      // app has to hold in memory and hand over.
      attach.length > 1 ? `<a class="attach-chip attach-chip-all" download href="${escAttr(API.attachmentsZipUrl(msg.__folder, msg.uid, msg.__account))}"
        title="${escAttr(I18n.t('Download every attachment on this message as one .zip'))}">⤓ ${esc(I18n.t('Download all'))} <small>(${attach.length}, ${Math.round(attach.reduce((n, a) => n + (a.size || 0), 0) / 1024)} KB)</small></a>` : ''
    }</div>` : ''}`;

  // Everything a rebuild of just the iframe needs (theme change) and everything
  // a reload of the whole card needs (the user allowing this message's images).
  card.__frameOpts = { html: msg.html, text: msg.text, fontFamily, fontSize, fontOverride, fonts: state.customFonts, expandQuote: !inThread };
  card.__msg = msg;
  card.__listEntry = listEntry;
  $('.mv-body-slot', card).appendChild(MessageFrame.create({ ...card.__frameOpts, ...themeColorsForFrame() }));

  bindAddressMenu(card);
  bindInvitation(card, listEntry);

  // :not(.attach-chip-all) — the bundle chip is a plain download and must keep
  // its default action. Without this it is swallowed like every other chip and
  // handed to the attachment VIEWER, which would try to preview a .zip.
  $$('.attach-chip:not(.attach-chip-all)', card).forEach((a) => a.addEventListener('click', (e) => {
    e.preventDefault();
    AttachmentViewer.open({ url: a.href, filename: a.dataset.filename, contentType: a.dataset.contentType });
  }));

  // Per message and not remembered: unfolding one banner says what this sender
  // offers, not that the setting was wrong.
  $('.mv-unsub-expand', card)?.addEventListener('click', (e) => {
    const b = e.currentTarget.closest('.mv-unsub-banner');
    const min = b.classList.toggle('mv-unsub-min');
    e.currentTarget.setAttribute('aria-expanded', min ? 'false' : 'true');
  });
  // Whatever the banner ends up saying afterwards is a result, not a standing
  // offer, so it is always shown in full.
  const unsubDone = (text) => {
    const b = $('.mv-unsub-banner', card);
    b.classList.remove('mv-unsub-min');
    b.innerHTML = `📭 ${text}`;
  };
  $('.mv-unsubscribe', card)?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const info = msg.headers.listUnsubscribe;
    const prompt = info.method === 'open'
      ? I18n.t('Open the unsubscribe page at {x}?').replace('{x}', info.label)
      : I18n.t('Send an unsubscribe request to {x}?').replace('{x}', info.label);
    if (!await Dialog.confirm(prompt, { title: I18n.t('Unsubscribe'), okLabel: I18n.t('Unsubscribe') })) return;
    // An ordinary link is opened HERE, not by the server: it is a page for a
    // person to finish, and opening it inside the click keeps a pop-up blocker
    // out of it (a window.open after an await is the classic way to lose one).
    if (info.method === 'open') {
      MessageFrame.openLink(info.http);
      // Still told the server, so this is written down under the sender like
      // the other two — it cannot know whether you finished on that page, but
      // "opened on the 27th" beats offering the button as if nothing happened.
      withMsgCtx(listEntry, (folder, acct) => API.unsubscribe(folder, listEntry.uid, acct))
        .then((r) => unsubDone(unsubSaid(r)))
        .catch(() => unsubDone(esc(I18n.t('Unsubscribe page opened'))));
      return;
    }
    btn.disabled = true;
    try {
      const r = await withMsgCtx(listEntry, (folder, acct) => API.unsubscribe(folder, listEntry.uid, acct));
      // Says WHAT was done and how it went, not just that something was sent —
      // an unsubscribe you cannot verify is barely better than none.
      unsubDone(unsubSaid(r));
      msg.unsubscribed = r;
    } catch (err) {
      btn.disabled = false;
      toast('Unsubscribe failed: ' + err.message, 5000);
    }
  });
  $('.mv-send-receipt', card)?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      const r = await withMsgCtx(listEntry, (folder, acct) => API.sendReceipt(folder, listEntry.uid, acct));
      // The banner is replaced rather than removed: "nothing happened" is
      // exactly what the old version looked like.
      $('.mv-receipt-banner', card).innerHTML = `📬 ${esc(I18n.t('Read receipt sent'))} (${esc(r.to || '')}).`;
    } catch (err) {
      btn.disabled = false;
      toast('Could not send the receipt: ' + err.message);
    }
  });
  $('.mv-show-images', card)?.addEventListener('click', () => reloadCard(card, { allowImages: true }));
  $('.mv-trust-domain', card)?.addEventListener('click', async () => {
    const list = new Set(state.settings.trustedDomains || []);
    list.add(msg.senderDomain);
    state.settings = await saveServerSettings({ trustedDomains: [...list] });
    reloadCard(card, {});
  });
  async function mvToggleStar() {
    const on = !listEntry.flagged;
    try {
      await trackMutation(withMsgCtx(listEntry, (folder, acct) => API.flags(folder, [listEntry.uid], on ? ['\\Flagged'] : [], on ? [] : ['\\Flagged'], acct)));
    } catch (err) { toast('Could not star message: ' + err.message); return; }
    listEntry.flagged = on;
    const btn = $('.mv-star-btn', card);
    if (btn) { btn.classList.toggle('on', on); btn.textContent = on ? '★' : '☆'; }
    // A conversation row draws one star for the whole thread, so starring any
    // one of its messages has to be reflected there too.
    const row = state.messages.find((r) => r.threadUids?.includes(listEntry.uid));
    if (row && on) row.threadFlagged = true;
    renderList();
  }
  async function mvToggleRead() {
    const seen = !listEntry.seen;
    try {
      await trackMutation(withMsgCtx(listEntry, (folder, acct) => API.flags(folder, [listEntry.uid], seen ? ['\\Seen'] : [], seen ? [] : ['\\Seen'], acct)));
    } catch (err) { toast('Could not update message: ' + err.message); return; }
    listEntry.seen = seen;
    noteMemberRead(listEntry, seen);
    renderList(); loadFolders();
  }
  /** Show/hide the full header block. Remembered as a setting, so the next
   *  message you open comes up the way you left the last one — that is the
   *  whole point of it being a persisted position rather than a per-message
   *  one. Inside a conversation the older cards still override it (they always
   *  start collapsed); toggling any of them still moves the remembered state. */
  function setHeadCollapsed(on, { remember = true } = {}) {
    const head = $('.mv-header-card', card);
    head.classList.toggle('mv-head-collapsed', on);
    const btn = $('.mv-head-toggle', card);
    btn.textContent = on ? '▾' : '▴';
    btn.title = I18n.t(on ? 'Show details' : 'Hide details');
    if (remember && !!state.settings.messageHeaderCollapsed !== on) {
      state.settings.messageHeaderCollapsed = on;
      // Fire-and-forget: this is a remembered position, not something to block
      // the click on, and a failed save just means the next message opens the
      // way the last saved one did.
      saveServerSettings({ messageHeaderCollapsed: on }).catch(() => {});
    }
  }
  $('.mv-head-toggle', card).addEventListener('click', (e) => {
    e.stopPropagation();
    setHeadCollapsed(!$('.mv-header-card', card).classList.contains('mv-head-collapsed'));
  });
  // A collapsed header is also a click target in its own right — the same
  // gesture that opens a collapsed message of a conversation.
  $('.mv-header-card', card).addEventListener('click', (e) => {
    const head = e.currentTarget;
    if (!head.classList.contains('mv-head-collapsed')) return;
    if (e.target.closest('button, a, .mv-banner')) return; // ★ / ⋯ / "show images" mean themselves
    setHeadCollapsed(false);
  });
  $('.mv-star-btn', card).addEventListener('click', mvToggleStar);
  $('.mv-more', card).addEventListener('click', (e) => {
    e.stopPropagation();
    const r = e.currentTarget.getBoundingClientRect();
    openCtxMenu([
      { label: 'Reply', onClick: () => Compose.reply(msg, false) },
      { label: 'Reply all', onClick: () => Compose.reply(msg, true) },
      { label: 'Forward', onClick: () => Compose.forward(msg, msg.__folder) },
      { label: listEntry?.seen ? 'Mark as unread' : 'Mark as read', onClick: mvToggleRead },
      { label: 'Move', onClick: () => showMoveDialog(msg, listEntry) },
      ...refileMenuItems(listEntry),
      // Same bar Ctrl+F opens — the menu entry exists because a phone has no
      // Ctrl key, and because a keyboard shortcut nobody is told about might
      // as well not be there. Scoped to THIS message's frame: in a conversation
      // the pane holds several, and "search in message" means the one whose
      // menu was opened.
      { label: 'Search in message', onClick: () => MessageFind.open($('iframe.mv-body-frame', card)) },
      // "This needs to be in my calendar" is a thing people do with a message
      // several times a week, and the alternative is retyping the subject into
      // a form. Offered only where there is somewhere to put it — a read-only
      // calendar cannot take one, and neither can no calendar at all.
      ...(hasWritableCalendar() ? [{ label: 'Add to calendar', onClick: () => eventFromMessage(msg) }] : []),
      { label: 'View headers', onClick: () => showHeadersDialog(msg) },
      { label: 'Print', onClick: () => printMessage(msg) },
      // Opening a whole new tab is an awkward, cramped gesture on a phone
      // (and "New view" implies more screen real estate than a phone has to
      // give it anyway) — desktop only, same width breakpoint every other
      // mobile-vs-desktop UI difference in this app already uses.
      ...(!isMobileViewport() ? [{ label: 'Open in new view', onClick: () => openMessageInNewView(msg) }] : []),
      { label: 'Delete', danger: true, onClick: () => quickDelete(listEntry) },
    ], r.right - 180, r.bottom + 4);
  });
  return card;
}

/** Re-fetches one card's message and swaps it in place — the two things that
 *  change what the BODY renders as ("show images", "always trust this
 *  sender"). Used to re-open the whole message; inside a conversation that
 *  would have thrown away every other card and the scroll position with it. */
async function reloadCard(card, { allowImages = false } = {}) {
  const listEntry = card.__listEntry;
  const prev = card.__msg;
  let fresh;
  try {
    fresh = await withMsgCtx(listEntry, (folder, acct) => API.message(folder, listEntry.uid, allowImages, acct));
  } catch (e) { toast('Could not reload message: ' + e.message); return; }
  fresh.__folder = prev.__folder;
  fresh.__account = prev.__account;
  if (!card.isConnected) return; // the pane moved on while we were fetching
  // Keeps this card's own header position across the rebuild — it is the same
  // message being redrawn, not a newly opened one.
  const collapsed = !!$('.mv-header-card.mv-head-collapsed', card);
  // Both of the things a rebuild must not silently change: where the header
  // was, and whether this card is one of a conversation.
  card.replaceWith(buildMessageCard(fresh, listEntry, { collapsed, inThread: !card.__frameOpts?.expandQuote }));
}

/**
 * Drops one message out of an open conversation, after that message has been
 * moved or deleted from under it. Returns false when there was no stack to
 * drop it from — a single open message, which its caller closes outright, the
 * way it always did.
 */
function dropOpenCard(entry) {
  const cards = $$('#message-view .mv-card');
  if (cards.length < 2) return false;
  const card = cards.find((c) => c.__listEntry?.uid === entry.uid);
  if (!card) return false;
  card.remove();
  return true;
}

/** One message of a conversation becoming read — keeps the list row's own
 *  unread count (which covers the whole thread) in step with it. */
function noteMemberRead(entry, seen) {
  const row = state.messages.find((r) => r.threadUids?.includes(entry.uid));
  if (!row) return;
  const n = row.threadUnseen || 0;
  row.threadUnseen = Math.max(0, Math.min(row.threadCount, seen ? n - 1 : n + 1));
  if (row.uid === entry.uid) row.seen = seen;
}

function renderMessage(view, msg, listEntry) {
  view.innerHTML = '';
  view.appendChild(buildMessageCard(msg, listEntry));
}

/* ---------- conversation (threaded) reading pane ---------- */

/**
 * A conversation, stacked oldest to newest with the newest one open and
 * scrolled to — everything before it is one line you can scroll up to and
 * click open.
 *
 * Collapsed by default for a reason worth stating: every expanded message is a
 * sandboxed iframe plus its own body fetch, so drawing a twenty-message thread
 * in full would cost twenty of each on open. This costs one listing request and
 * one body.
 */
async function openThread(m) {
  const { folder, accountId } = msgCtx(m);
  const view = $('#message-view');
  let members;
  try {
    members = (await API.thread(m.threadId, listedFolderFor(m), accountId)).messages;
  } catch (e) {
    // The thread listing is a cache read and can only really fail if the cache
    // is off or the row is stale. Either way the message itself still opens.
    return showSingleMessage(view, m);
  }
  if (state.openUid !== m.uid) return; // something else was opened while we fetched
  if (members.length < 2) return showSingleMessage(view, m);
  correctThreadCount(m, members.length);

  // Each member acts (star, mark read, delete) through the same withMsgCtx path
  // a list row does, which resolves the account off the entry itself — in the
  // unified view there is no ambient one to fall back to.
  for (const entry of members) if (m.account) entry.account = m.account;
  const newest = members[members.length - 1];

  // The newest message's body is fetched BEFORE the pane is touched. Painting
  // the stack first and filling it in afterwards is what made the pane flash on
  // open: collapsed lines appeared, then a card replaced the last of them, then
  // the scroll jumped. One paint, already sitting on the bottom message.
  let newestMsg = null;
  try {
    newestMsg = await withMsgCtx(newest, (f, acct) => API.message(f, newest.uid, false, acct));
  } catch (e) { /* handled below — the conversation is still perfectly readable */ }
  if (state.openUid !== m.uid) return;

  view.classList.remove('mv-placeholder');
  view.innerHTML = '';
  // Everything older is a one-line header. Its own message opens on click.
  for (const entry of members.slice(0, -1)) view.appendChild(buildThreadStub(entry));

  if (!newestMsg) {
    // Its body didn't load. Leave a line that can be clicked to try again
    // rather than an empty pane or a placeholder that says "Loading…" forever.
    view.appendChild(buildThreadStub(newest));
    toast('Could not open the newest message in this conversation');
    return;
  }
  newestMsg.__folder = newest.folder;
  newestMsg.__account = accountOf(newest);
  const card = buildMessageCard(newestMsg, newest, { inThread: true });
  view.appendChild(card);
  // Same read-marking rule as opening a single message — per message, as it is
  // opened, rather than marking a whole conversation read for having glanced at
  // the end of it.
  scheduleMarkRead(newest);

  // "Expand every message in a conversation" (Settings › General). The rest are
  // opened after this one is on screen and pinned, so the pane is readable
  // immediately instead of waiting on N fetches — and the pin is held until
  // they are all in, since each one appears ABOVE the message you are reading.
  const rest = state.settings.conversationExpandAll ? expandAllStubs(view) : null;
  stickCardToTop(card, rest);
}

/** Opens every collapsed message of the conversation, oldest first. */
async function expandAllStubs(view) {
  for (const stub of $$('.mv-stub', view)) {
    if (!stub.isConnected) continue;
    // Sequentially, not Promise.all: a twenty-message thread would otherwise
    // fire twenty body fetches at one mail server at once.
    await expandThreadStub(stub, stub.__listEntry, { collapsed: true });
  }
}

/** The collapsed form: sender, date and marks on one line. Clicking it fetches
 *  that message's body and swaps in a full card. */
function buildThreadStub(entry) {
  const el = document.createElement('div');
  el.className = 'mv-card mv-stub' + (entry.seen ? '' : ' unread');
  const who = entry.from?.name || entry.from?.address || '(unknown)';
  el.innerHTML = `
    <span class="mv-stub-from">${esc(who)}</span>
    <span class="mv-stub-marks">${entry.flagged ? '★' : ''}${entry.hasAttachment ? '📎' : ''}</span>
    <span class="mv-stub-date">${esc(fmtDate(entry.date))}</span>`;
  el.title = I18n.t('Show this message');
  el.__listEntry = entry; // so dropOpenCard can find it if it is deleted or moved
  el.addEventListener('click', () => expandThreadStub(el, entry, { collapsed: true }));
  return el;
}

/** Fetches one member's body and replaces its collapsed line with a real card.
 *  Returns the card (or null if the fetch failed or the pane moved on).
 *  `collapsed` is passed straight to the card: an older message of a
 *  conversation always opens with its header block collapsed, whatever the
 *  remembered position is. */
async function expandThreadStub(stub, entry, { collapsed = true } = {}) {
  if (!stub || stub.__expanding) return null;
  stub.__expanding = true;
  let msg;
  try {
    msg = await withMsgCtx(entry, (folder, acct) => API.message(folder, entry.uid, false, acct));
  } catch (e) {
    stub.__expanding = false;
    toast('Could not open message: ' + e.message);
    return null;
  }
  if (!stub.isConnected) return null;
  msg.__folder = entry.folder;
  msg.__account = accountOf(entry);
  const card = buildMessageCard(msg, entry, { collapsed, inThread: true });
  stub.replaceWith(card);
  scheduleMarkRead(entry);
  return card;
}

/** Scrolls the reading pane so this card's header sits at the top of it. */
function scrollCardToTop(card) {
  const pane = card.closest('.reading-pane');
  if (!pane) { card.scrollIntoView({ block: 'start' }); return; }
  pane.scrollTop += card.getBoundingClientRect().top - pane.getBoundingClientRect().top;
}

/**
 * Keeps a just-opened card pinned to the top of the pane while the stack
 * settles, and abandons the pin the moment the user scrolls for themselves.
 *
 * Two things move under it. A message body is an iframe whose height is only
 * known once its content has loaded and reported back (messageFrame.js) — and
 * until it does, the stack is barely taller than the pane, so a scroll to the
 * bottom card clamps short and the card visibly jumps into place a moment
 * later. That is what the temporary min-height is for: it makes the target
 * position reachable on the first try, and is dropped again the instant the
 * real height arrives. The other is every card ABOVE this one growing as it
 * expands ("expand every message"), which is why `done` can hold the pin open.
 */
function stickCardToTop(card, done) {
  const stack = card.parentElement;
  const pane = card.closest('.reading-pane') || stack;
  if (!stack || !pane) return;
  const frame = $('iframe.mv-body-frame', card);
  card.style.minHeight = pane.clientHeight + 'px';
  scrollCardToTop(card);
  if (!window.ResizeObserver) { card.style.minHeight = ''; return; }

  // The frame's FIRST report is the observation of its current (empty) size;
  // the next one is its real content height, and that is when the reservation
  // has done its job.
  let firstReport = true;
  const release = () => {
    if (!card.style.minHeight) return;
    card.style.minHeight = '';
    if (card.isConnected) scrollCardToTop(card);
  };
  const fo = frame ? new ResizeObserver(() => {
    if (firstReport) { firstReport = false; return; }
    fo.disconnect();
    release();
  }) : null;
  fo?.observe(frame);
  const releaseTimer = setTimeout(() => { fo?.disconnect(); release(); }, 1500);

  const ro = new ResizeObserver(() => { if (card.isConnected) scrollCardToTop(card); });
  ro.observe(stack);
  const events = ['wheel', 'touchstart', 'keydown', 'mousedown'];
  const stop = () => {
    clearTimeout(releaseTimer);
    fo?.disconnect();
    release();
    ro.disconnect();
    for (const ev of events) pane.removeEventListener(ev, stop);
  };
  for (const ev of events) pane.addEventListener(ev, stop, { passive: true });
  // A tail after the last thing that moves: the settling report of whichever
  // body finished last still has to be caught.
  if (done) done.then(() => setTimeout(stop, 1200), () => setTimeout(stop, 1200));
  else setTimeout(stop, 3000);
}

/** "Move" from the message view's Open-menu — no per-message move existed
 * outside select-mode's batch action before this. */
async function showMoveDialog(msg, listEntry) {
  let folders;
  try { folders = await API.folders(msg.__account || undefined); }
  catch (e) { toast('Cannot load folders: ' + e.message); return; }
  const options = folders.filter((f) => f.path !== msg.__folder && !f.hidden && !f.system);
  if (!options.length) { toast('No other folders to move to'); return; }
  const bodyHtml = `<label class="dialog-label">${I18n.t('Move to folder')}</label>
    <select class="dialog-input" id="mv-move-target">
      ${options.map((f) => `<option value="${escAttr(f.path)}">${esc(f.path)}</option>`).join('')}
    </select>`;
  const target = await Dialog.form(I18n.t('Move'), bodyHtml, {
    okLabel: I18n.t('Move'),
    getValue: (root) => root.querySelector('#mv-move-target').value,
  });
  if (!target) return;
  try {
    await trackMutation(withMsgCtx(listEntry, (folder, acct) => API.move(folder, [listEntry.uid], target, acct)));
    toast('Moved to ' + target);
    if (!dropOpenCard(listEntry)) closeMessage();
    loadMessages(); loadFolders();
  } catch (e) { toast('Move failed: ' + e.message); }
}

/* ---------- view headers dialog ---------- */
function closeHeadersDialog() {
  $('#headers-dialog-backdrop')?.remove();
  document.removeEventListener('keydown', headersDialogEscHandler);
}
function headersDialogEscHandler(e) { if (e.key === 'Escape') closeHeadersDialog(); }

async function showHeadersDialog(msg) {
  let data;
  try {
    data = await API.messageHeaders(msg.__folder, msg.uid, msg.__account);
  } catch (e) { toast('Could not load headers: ' + e.message); return; }

  closeHeadersDialog();
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop dialog-backdrop';
  backdrop.id = 'headers-dialog-backdrop';
  backdrop.innerHTML = `
    <div class="modal dialog" role="dialog" aria-modal="true">
      <div class="dialog-title">${I18n.t('Message headers')}</div>
      <div class="dialog-body">
        <div class="dialog-wide">
          <div class="headers-table-wrap">
            <table class="headers-table">
              ${data.list.map((h) => `<tr><th>${esc(h.name)}</th><td>${esc(h.value)}</td></tr>`).join('')}
            </table>
          </div>
        </div>
      </div>
      <div class="dialog-buttons">
        <button class="link-btn" id="headers-copy">${I18n.t('Copy raw headers')}</button>
        <button class="link-btn" id="headers-eml">${I18n.t('Save as EML')}</button>
        <span class="spacer"></span>
        <button class="link-btn dialog-cancel">${I18n.t('Close')}</button>
      </div>
    </div>`;
  document.body.appendChild(backdrop);
  backdrop.querySelector('#headers-copy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(data.raw); toast('Copied'); }
    catch { toast('Could not copy to clipboard'); }
  });
  // The whole raw message, saved as a .eml file — a plain anchor navigation to
  // the server route rather than a Blob built here, so nothing has to hold the
  // full source in memory and the Android shell's DownloadListener sees a
  // normal download with the session cookie attached (an in-page Blob URL
  // wouldn't reach it, and JS can't read the HttpOnly cookie to re-fetch).
  backdrop.querySelector('#headers-eml').addEventListener('click', () => {
    const name = (msg.subject || 'message').replace(/[\\/:*?"<>|]+/g, '_').trim().slice(0, 120) || 'message';
    const a = document.createElement('a');
    a.href = API.messageEmlUrl(msg.__folder, msg.uid, name, msg.__account);
    a.download = name + '.eml';
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
  });
  backdrop.querySelector('.dialog-cancel').addEventListener('click', closeHeadersDialog);
  backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) closeHeadersDialog(); });
  document.addEventListener('keydown', headersDialogEscHandler);
}

/** "Open in new view" — same message.html popout the readingPane:'window'
 * setting already opens automatically for every message, just available
 * on demand for one message at a time regardless of the current reading-
 * pane mode. Desktop only (see the menu item's own comment). */
function openMessageInNewView(msg) {
  const win = window.open(`/message.html#${encodeURIComponent(msg.__folder)}/${encodeURIComponent(msg.uid)}/${encodeURIComponent(msg.__account || '')}`, '_blank');
  if (!win) toast('Pop-up blocked — allow pop-ups for Hmelj to open a new view');
}

/* ---------- print ---------- */
function printMessage(msg) {
  const from = msg.from?.[0] || {};
  const toLine = (msg.to || []).map((t) => t.name || t.address).join(', ') || 'me';
  const ccLine = (msg.cc || []).length ? msg.cc.map((t) => t.name || t.address).join(', ') : '';
  // Linkified like the reading pane (MessageFrame.linkifyText) — a plain-text
  // mail printed to PDF keeps working links instead of flat text.
  const body = msg.html || `<pre style="white-space:pre-wrap;font-family:inherit">${MessageFrame.linkifyText(msg.text)}</pre>`;
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(msg.subject || '(no subject)')}</title>
<style>
  body { font-family: system-ui, sans-serif; color: #1f1f1f; margin: 24px; }
  .p-subject { font-size: 20px; font-weight: 600; margin: 0 0 10px; }
  .p-meta { font-size: 13px; color: #555; border-bottom: 1px solid #ccc; padding-bottom: 10px; margin-bottom: 16px; }
  .p-meta div { margin: 2px 0; }
  img { max-width: 100%; }
  @media print { body { margin: 0; } }
</style></head><body>
  <div class="p-subject">${esc(msg.subject || '(no subject)')}</div>
  <div class="p-meta">
    <div><b>From:</b> ${esc(from.name ? from.name + ' <' + from.address + '>' : (from.address || ''))}</div>
    <div><b>To:</b> ${esc(toLine)}</div>
    ${ccLine ? `<div><b>Cc:</b> ${esc(ccLine)}</div>` : ''}
    <div><b>Date:</b> ${esc(fmtDate(msg.date, { long: true }))}</div>
  </div>
  ${body}
</body></html>`;
  // A same-page hidden iframe, not window.open+popup: a WebView wrapper with no
  // multi-window support configured (Android's MainActivity.kt never sets
  // setSupportMultipleWindows/onCreateWindow) makes window.open return null,
  // silently doing nothing — and since that never touched any app navigation
  // state either, it also left the app in a state where the very next
  // back-button press had nothing of ours to consume, surfacing as an
  // unrelated "press back again to change server URL" prompt right after a
  // failed Print tap. An iframe never opens a new window, so neither problem
  // applies here, and modern Chromium-based WebView (what both the APK and
  // PWA use) natively wires an iframe's window.print() to the system print
  // dialog with no app-side support needed.
  const iframe = document.createElement('iframe');
  iframe.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden;';
  iframe.setAttribute('aria-hidden', 'true');
  const cleanup = () => iframe.remove();
  iframe.addEventListener('load', () => {
    const win = iframe.contentWindow;
    // A reply arrives with its quoted half hidden behind the ⋯ button (marked
    // by server/quoteCollapse.js, opened by the frame's own click handler —
    // neither of which exists in here). On paper that button does nothing, and
    // a printed reply with the mail it was replying to left out is not a
    // printed reply, so this document gets the whole thing.
    const doc = iframe.contentDocument;
    if (doc) {
      doc.querySelectorAll('.hmelj-quote-toggle').forEach((b) => b.remove());
      doc.querySelectorAll('.hmelj-quoted').forEach((el) => {
        el.classList.remove('hmelj-quoted');
        el.style.removeProperty('display');
      });
    }
    win.addEventListener('afterprint', cleanup);
    win.focus();
    win.print();
    // Backstop: afterprint isn't universally reliable from inside an iframe —
    // don't leave the hidden iframe attached forever if it never fires.
    setTimeout(cleanup, 60000);
  });
  iframe.srcdoc = html;
  document.body.appendChild(iframe);
}

/* ---------- reading pane layout ---------- */
function applyReadingPane() {
  const c = $('#content');
  // classList.add/remove (not className=) so it doesn't clobber the
  // mobile-show-message class toggled independently in openMessage/closeMessage.
  c.classList.remove('pane-right', 'pane-bottom', 'pane-window', 'pane-off');
  c.classList.add('pane-' + (state.settings.readingPane || 'right'));
}

/* ---------- toolbar actions ---------- */
/** Batch op over selected uids; in the unified view, fan out per source account. */
/** Every mail-state mutation made from the list or the toolbar goes through
 * here, which makes it the one place that has to register itself with
 * trackMutation — see the reconcile-scheduling comment. (Single-message paths
 * that use withMsgCtx instead wrap themselves at their own call sites; that
 * helper is also used for a plain read.) */
function batchOp(uids, fn) {
  return trackMutation(batchOpInner(uids, fn));
}

async function batchOpInner(uids, fn) {
  // Group by (account, folder) in EVERY view, not just the unified one. A
  // single-account list used to be safe to treat as one folder, but the starred
  // filter spans a folder's whole subtree (see state.starredOnly), so its rows can
  // sit in different folders while state.currentFolder names only the root — acting
  // on them wholesale there would target the wrong mailbox. Where no row carries a
  // folder of its own this still produces exactly the single call it always did.
  const defaultFolder = state.currentAccount === 'all' ? 'INBOX' : state.currentFolder;
  const byUid = new Map(state.messages.map((m) => [m.uid, m]));
  const byCtx = new Map();
  for (const uid of uids) {
    // A uid with no row left in the list (paged away, already removed) still has to
    // be acted on — the current view is the only context there is for it.
    const m = byUid.get(uid);
    const folder = m?.folder || defaultFolder;
    const account = m?.account?.id || null;
    const key = (account || '') + '|' + folder;
    if (!byCtx.has(key)) byCtx.set(key, { account, folder, uids: [] });
    byCtx.get(key).uids.push(uid);
  }
  for (const g of byCtx.values()) {
    await fn(g.folder, g.uids, g.account);
  }
}

/**
 * batchOp plus the two things every caller of it was missing: error handling
 * (an unawaited rejection left the list never reloading and showed nothing),
 * and the unread-badge nudge (the single-message paths all do this via
 * adjustUnreadCounts; the toolbar ones didn't, so a bulk mark-read left every
 * badge stale until a full server round trip).
 *
 * `delta` is the per-message change to unread, applied only to messages
 * `affects` says will actually move (marking 10 already-read messages read
 * must not move the badge by -10). Returns false if the op failed.
 */
async function runBatch(uids, fn, delta) {
  // How much this action moves the unread badges, per affected ROW. `delta`
  // says which way: -1 is "unread messages stop being unread" (read, deleted),
  // +1 is "read messages become unread". A conversation row stands for several
  // messages, so it moves the badge by however many of ITS messages actually
  // changed state — a thread with three unread drops the badge by three.
  const affected = (m) => {
    const unread = m.threadUids ? (m.threadUnseen || 0) : (m.seen ? 0 : 1);
    return delta < 0 ? unread : (m.threadUids ? m.threadCount : 1) - unread;
  };
  const moved = state.messages.filter((m) => uids.includes(m.uid));
  try {
    await batchOp(uids, fn);
  } catch (e) {
    toast('Action failed: ' + e.message, 4000);
    return false;
  }
  for (const m of moved) {
    const n = affected(m);
    if (n) adjustUnreadCounts(m, delta * n);
  }
  return true;
}

function bindToolbar() {
  $('#btn-select-mode').addEventListener('click', () => { if (requireAccount()) setSelectMode(!state.selectMode); });
  $('#sel-exit').addEventListener('click', () => setSelectMode(false));
  // Clicking the count itself toggles select-all/none — the injected row
  // has no dedicated "select all" control otherwise.
  $('#select-count').addEventListener('click', () => {
    // Compared against the total number of MESSAGES on the page, not rows — a
    // conversation contributes all of its own (rowUids), so "everything is
    // selected" has to be counted the same way it was built.
    const everything = state.messages.flatMap(rowUids);
    state.selected = state.selected.size === everything.length ? new Set() : new Set(everything);
    updateSelectToolbar(); renderList();
  });
  $('#sel-delete').addEventListener('click', async () => {
    const uids = [...state.selected]; if (!uids.length) return toast('Nothing selected');
    const msg = uids.length === 1 ? I18n.t('Delete this message?') : I18n.t('Delete {n} messages?').replace('{n}', uids.length);
    if (!await Dialog.confirm(msg, { title: I18n.t('Delete'), okLabel: I18n.t('Delete'), danger: true })) return;
    if (!await runBatch(uids, (folder, u, acct) => API.deleteMsgs(folder, u, acct), -1)) return;
    setSelectMode(false); closeMessage(); loadMessages(); scheduleReconcile(2);
  });
  $('#sel-read').addEventListener('click', async () => {
    const uids = [...state.selected]; if (!uids.length) return toast('Nothing selected');
    if (!await runBatch(uids, (folder, u, acct) => API.flags(folder, u, ['\\Seen'], [], acct), -1)) return;
    setSelectMode(false); loadMessages(); scheduleReconcile(2);
  });
  $('#sel-unread').addEventListener('click', async () => {
    const uids = [...state.selected]; if (!uids.length) return toast('Nothing selected');
    if (!await runBatch(uids, (folder, u, acct) => API.flags(folder, u, [], ['\\Seen'], acct), +1)) return;
    setSelectMode(false); loadMessages(); scheduleReconcile(2);
  });
  $('#sel-move-target').addEventListener('change', async (e) => {
    const target = e.target.value; e.target.value = '';
    if (!target) return;
    const uids = [...state.selected]; if (!uids.length) return toast('Nothing selected');
    await batchOp(uids, (folder, u, acct) => API.move(folder, u, target, acct));
    setSelectMode(false); closeMessage(); loadMessages(); loadFolders();
    toast('Moved to ' + target);
  });
  // Checked/unchecked icon buttons, not native checkboxes — toggling one flips
  // .active (see .icon-btn.active in app.css) and aria-pressed together so the
  // pressed-look and the accessible state never drift apart.
  $('#btn-unread-only').addEventListener('click', (e) => {
    const pressed = e.currentTarget.classList.toggle('active');
    e.currentTarget.setAttribute('aria-pressed', String(pressed));
    state.unreadOnly = pressed;
    state.page = 1;
    loadMessages();
  });
  // Not persisted (see state.starredOnly) — a filter that hides most of the mailbox
  // shouldn't outlive the tab that asked for it.
  $('#btn-starred-only').addEventListener('click', (e) => {
    const pressed = e.currentTarget.classList.toggle('active');
    e.currentTarget.setAttribute('aria-pressed', String(pressed));
    state.starredOnly = pressed;
    state.page = 1;
    loadMessages();
  });
  $('#btn-show-muted').addEventListener('click', async (e) => {
    const pressed = e.currentTarget.classList.toggle('active');
    e.currentTarget.setAttribute('aria-pressed', String(pressed));
    state.showMuted = pressed;
    state.page = 1;
    loadMessages();
    // Persisted, not per-tab: the badges are summed server-side from this same
    // preference (see server/unread.js), including for a device with no page
    // open. refreshUnread() then repaints them with the new number — without it
    // the list would change while every count sat at the old total.
    try { await saveServerSettings({ showMuted: pressed }); } catch { /* offline — the list still filtered locally */ }
    refreshUnread();
  });
  $('#btn-layout').addEventListener('click', (e) => { e.stopPropagation(); $('#layout-menu').classList.toggle('open'); });
  $('#layout-menu').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-layout]'); if (!btn) return;
    state.settings = await saveServerSettings({ listLayout: btn.dataset.layout });
    applyListLayout();
    $('#layout-menu').classList.remove('open');
  });
  document.addEventListener('click', (e) => { if (!e.target.closest('.layout-menu-wrap')) $('#layout-menu').classList.remove('open'); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $('#layout-menu').classList.remove('open'); });
  $('#btn-refresh').addEventListener('click', async () => {
    // Offline this button is the offline marker (see applyOfflineMarkers), and
    // pressing it asks a question rather than starting a sync there is no
    // server for.
    if (!Connection.isOnline()) return explainOffline();
    if (!requireAccount()) return;
    // Already spinning — either this same handler still in flight, or a
    // background sync already doing the exact same work (see
    // backgroundSyncActive/pollSyncStatus) — triggering a second one on top
    // would just add load for no benefit.
    if (manualRefreshInFlight || backgroundSyncActive) return;
    manualRefreshInFlight = true;
    updateRefreshSpin();
    try {
      // A plain reload just re-reads whatever's already in the cache — it
      // can't show a flag change made on another mail client any sooner
      // than the next scheduled full sync pass (see sync.js#pollFolder).
      // Force one now for whatever's actually on screen instead.
      //
      // Capped client-side too, separately from the server's own IMAP
      // socket timeout: in the unified view this fires one request per
      // account, and without a cap here the spinner (and the reload right
      // after it) waited on whichever ONE account happened to be slowest —
      // one sluggish server made refresh look hung for everything, not
      // just that account. The requests keep running server-side either
      // way; this only stops the UI from waiting on all of them.
      // Every in-scope folder for each account (INBOX + its subfolders +
      // Sent), not just INBOX — a server-side rule filing new mail straight
      // into a custom subfolder used to go unnoticed by this button even
      // though it already shows up in the unified list either way.
      const withTimeout = (p, ms) => Promise.race([p, new Promise((resolve) => setTimeout(resolve, ms))]);
      if (state.currentAccount === 'all') {
        await withTimeout(Promise.all(activeAccounts().map((a) => API.syncAccountNow(a.id).catch(() => {}))), 8000);
      } else {
        await withTimeout(API.syncFolderNow(state.currentFolder).catch(() => {}), 8000);
      }
    } finally {
      manualRefreshInFlight = false;
      updateRefreshSpin();
    }
    loadMessages();
    loadFolders();
  });
  // A search can take many seconds (a live IMAP body-search across every account, not
  // a cache read — see API.unified's own timing) — without this, pressing Enter/
  // clicking again out of impatience while one's still running fires ANOTHER full
  // live search on top of it instead of just waiting, which piles up concurrent IMAP
  // connections to the very accounts already struggling to respond (Gmail in
  // particular actively penalizes an account for multiple concurrent sessions doing
  // heavy work — see imapClient.js's own connection-pooling comment), making the
  // whole thing slower still rather than faster. loadMessages()'s own seq guard
  // already makes a stale response harmless if this is ever bypassed some other way;
  // this stops the redundant fetch from being fired in the first place.
  let searchInFlight = false;
  const doSearch = async () => {
    if (searchInFlight) return;
    searchInFlight = true;
    const btn = $('#btn-search');
    btn.classList.add('spinning');
    try {
      state.query = $('#search-input').value.trim();
      state.savedSearchId = null;   // typed over: this is a new question, not the pinned one
      state.searchScope = 'folder'; // a new search always starts cheap; the footer offers the rest
      state.searchScopeUsed = null;   // unknown until this search's own answer lands
      state.page = 1;
      await loadMessages();
    } finally {
      searchInFlight = false;
      btn.classList.remove('spinning');
    }
  };
  $('#btn-search').addEventListener('click', () => { if (requireAccount()) doSearch(); });
  $('#search-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { if (requireAccount()) doSearch(); }
    else if (e.key === 'Escape') rejectSearchSuggestion();
    else if (e.key === 'Tab' && acceptSearchSuggestion()) e.preventDefault(); // only swallow Tab's normal focus-move when there's actually a suggestion to accept
    // First Backspace while a suggestion is showing just dismisses it (back
    // to exactly what was typed) rather than also deleting a real character
    // — native "delete the selection" behavior for this exact case turned
    // out to be unreliable on mobile (the input event it fires can re-fetch
    // and re-apply the very same suggestion before the deletion is even
    // visible, making it look like Backspace does nothing at all). A second
    // Backspace, with nothing selected anymore, behaves normally.
    else if (e.key === 'Backspace' && rejectSearchSuggestion()) e.preventDefault();
  });
  $('#search-input').addEventListener('input', (e) => { onSearchInput(e); updateSearchClearBtn(); });
  $('#btn-search-clear').addEventListener('click', () => {
    $('#search-input').value = '';
    updateSearchClearBtn();
    doSearch();
    $('#search-input').focus();
  });
  $('#btn-menu').addEventListener('click', () => setSidebarOpen($('#sidebar').classList.contains('collapsed')));
  $('#sidebar-backdrop').addEventListener('click', () => setSidebarOpen(false));
  $('#btn-mv-back').addEventListener('click', () => closeMessage());
  // A real sibling button in the same row (see .mv-top-row), so it needs no
  // event juggling to avoid also triggering Back, and Enter/Space reach it for
  // free.
  $('#mv-offline-chip')?.addEventListener('click', () => explainOffline());

  $('#btn-user-menu').addEventListener('click', openUserMenu);
  $('#user-menu-backdrop').addEventListener('mousedown', (e) => { if (e.target === $('#user-menu-backdrop')) closeUserMenu(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeUserMenu(); });
  // Every item's own handler (theme/settings/accounts/.../logout) is wired
  // elsewhere and does its thing regardless of where it lives — this just
  // closes the sheet afterward without having to touch each one individually.
  $('#user-menu-sheet').addEventListener('click', (e) => { if (e.target.closest('.sheet-item')) closeUserMenu(); });
  $('#btn-theme').addEventListener('click', showThemePicker);
  $('#btn-analytics').addEventListener('click', () => { if (requireAccount()) Analytics.open(); });
  $('#btn-run-filters').addEventListener('click', async () => {
    if (!requireAccount()) return;
    let matched = 0;
    if (state.currentAccount === 'all') {
      // run everyone's inbox through the filters
      for (const a of state.accounts) {
        try { matched += (await API.runFilters('INBOX', a.id)).matched; } catch { /* skip unreachable */ }
      }
    } else {
      matched = (await API.runFilters(state.currentFolder)).matched;
    }
    toast(`Filters matched ${matched} message(s)`);
    loadMessages(); loadFolders();
  });
  $('#btn-compose').addEventListener('click', () => { if (requireAccount()) Compose.open(); });
  // Toggles the account list into reorder mode and, on the way back out,
  // saves the new order to the server (see setAccountEditMode).
  $('#btn-accounts-edit').addEventListener('click', () => setAccountEditMode(!accountEditMode));
  // Mobile-only FAB — same action as the sidebar's own Compose button;
  // visibility (list view only) is handled entirely in CSS, see app.css's
  // mobile media query.
  $('#btn-fab-compose').addEventListener('click', () => { if (requireAccount()) Compose.open(); });
  // "Hmelj" brand row doubles as a manual reload — see the CSS comment on
  // .sidebar-brand for why this matters specifically for a backgrounded/
  // resumed WebView install. keydown covers this being a plain div with
  // role="button" (not a real <button>, to match the existing div-based
  // clickable-row convention already used for accounts/folders/messages),
  // which needs its own Enter/Space handling for keyboard users.
  $('#btn-reload-app').addEventListener('click', () => location.reload());
  $('#btn-reload-app').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); location.reload(); }
  });
  $('#btn-settings').addEventListener('click', () => Settings.open());
  $('#btn-accounts-manage').addEventListener('click', () => Settings.open('accounts'));
  $('#btn-folders-manage').addEventListener('click', () => { if (requireAccount()) Settings.open('folders'); });
  $('#btn-contacts').addEventListener('click', () => Settings.open('contacts'));
}

/* ---------- search box: inline autocomplete ----------
 * Ghost text, browser-address-bar style — not a dropdown. Server side
 * (cache.js#suggestWord) is a local SQLite prefix lookup against words
 * seen across all synced mail, so it's cheap enough to debounce lightly
 * rather than needing to wait for a real search. The "ghost" is just the
 * suggested tail shown SELECTED inside the input itself (no overlay
 * element to keep pixel-aligned with the real text) — which gets most of
 * accept/reject for free from how text selections already behave: →/End
 * collapses the selection to a cursor position (accepts), typing a
 * character replaces it (rejects, continues from what was actually typed),
 * Backspace deletes it (rejects), Enter searches whatever .value currently
 * holds, selected tail included. Tab and Escape both need an explicit
 * handler though (acceptSearchSuggestion/rejectSearchSuggestion, wired
 * above) — Tab's own default action is "move focus to the next element,"
 * not collapse the selection, and Escape isn't bound to anything here by
 * default at all. */
let searchSuggestTimer = null;

/* The scope prefix of one search term — an optional +/- sign, an optional
 * recognized `field:`, an optional opening quote — stripped off before the
 * word index is asked to complete it. Without this, typing `from:ali` asked
 * for a completion of the literal string "from:ali", which the index (plain
 * lowercase words, see cache.js#tokenizeWords) can never match, so scoping a
 * search silently turned autocomplete off.
 *
 * The field list is kept in sync BY HAND with server/searchQuery.js's
 * FIELD_NAMES, exactly as queryIsLiveSweep is with STARRED_TERM_RE — and, like
 * that parser, an UNRECOGNIZED prefix is deliberately left whole (a URL, a
 * literal 10:30), since there it is plain text and completing past the colon
 * would suggest a word the search will never look for. */
const SEARCH_TERM_PREFIX_RE = /^[+-]?(?:(?:from|to|subject|body):)?"?/i;

/** Shows/hides the ✕ button at the end of the search field — visible
 * exactly when there's anything to clear. Called on every keystroke and
 * everywhere else the field's value changes programmatically (clearing it
 * on folder/account navigation, the button's own click handler). */
function updateSearchClearBtn() {
  $('#btn-search-clear').hidden = !$('#search-input').value;
}

function onSearchInput(e) {
  clearTimeout(searchSuggestTimer);
  if (!state.settings.searchAutocomplete) return;
  const input = e.target;
  const val = input.value;
  // Only when the cursor is collapsed at the very end — editing back inside
  // already-typed text should never trigger a stray completion there.
  if (input.selectionStart !== val.length || input.selectionEnd !== val.length) return;
  const lastWord = val.slice(val.lastIndexOf(' ') + 1); // no space found -> lastIndexOf is -1, +1 -> whole value
  // Only the WORD part is looked up; the `from:`/`-subject:"` in front of it is
  // typed text the completion is appended after, untouched (see the regex above).
  const stem = lastWord.replace(SEARCH_TERM_PREFIX_RE, '');
  if (stem.length < 2) return;
  searchSuggestTimer = setTimeout(() => applySearchSuggestion(input, val, stem), 100);
}

async function applySearchSuggestion(input, val, stem) {
  if (input.value !== val) return; // stale — typing continued before this fired
  let completion;
  try { ({ completion } = await API.searchSuggest(stem)); } catch { return; }
  // completion (if any) is a plain lowercase word from the index; slicing
  // off just the extra tail and appending it to `val` verbatim — rather
  // than replacing the whole typed prefix with the (lowercase) completion
  // — preserves whatever casing was actually typed, and keeps any field
  // scope in front of it intact (`stem` is always a suffix of `val`).
  if (!completion || completion.length <= stem.length || input.value !== val) return;
  const fullValue = val + completion.slice(stem.length);
  input.value = fullValue;
  input.setSelectionRange(val.length, fullValue.length);
}

/** Escape/Backspace: drop a currently-shown suggestion back to just what was
 * typed — returns whether there actually was one to drop, same reasoning as
 * acceptSearchSuggestion below (Backspace needs to know whether it should
 * swallow this press as "just dismiss the suggestion" or fall through to
 * its normal behavior). A no-op, returning false, if nothing's selected. */
function rejectSearchSuggestion() {
  const input = $('#search-input');
  if (input.selectionStart === input.selectionEnd) return false;
  const typed = input.value.slice(0, input.selectionStart);
  input.value = typed;
  input.setSelectionRange(typed.length, typed.length);
  return true;
}

/** Tab: →/End/Home already collapse a text selection to a cursor position
 * as their normal default browser behavior (no code needed for those —
 * see the comment above onSearchInput) — Tab's own default action is
 * "move focus to the next element" instead, which doesn't touch the
 * selection at all, so accepting a suggestion with it needs an explicit
 * handler. Returns whether there actually was a suggestion to accept, so
 * the keydown listener only swallows Tab's normal focus-move when there
 * was one — with nothing showing, Tab still moves focus onward as usual. */
function acceptSearchSuggestion() {
  const input = $('#search-input');
  if (input.selectionStart === input.selectionEnd) return false;
  input.setSelectionRange(input.value.length, input.value.length);
  return true;
}

/** Paints every place the username appears: the sidebar footer, the user
 * menu's header, the avatar letters, and the Log out tooltip.
 *
 * A function rather than four lines inside boot() because a username can
 * change while the app is running — changing only its capitalization
 * ("andrej" → "Andrej") keeps the same login name, so it deliberately does NOT
 * sign you out (see server/session.js#renameUser's `unchanged` case) and
 * therefore never gets a reload to repaint it. Settings calls this after a
 * successful rename; without it the new spelling was stored server-side but
 * every visible copy stayed as it was, which looked exactly like the rename
 * having been ignored.
 *
 * No separate "display name" field exists in the user model — just the login
 * username — so the avatar is its first letter and the label/menu header both
 * show the username itself. */
function applyUsername() {
  const name = state.username || '';
  $('#btn-logout').title = I18n.t('Log out') + ' (' + name + ')';
  const initial = ([...name][0] || '?').toUpperCase();
  $('#user-avatar').textContent = initial;
  $('#user-menu-avatar-lg').textContent = initial;
  $('#user-menu-label').textContent = name;
  $('#user-menu-username').textContent = name;
}

/* ---------- boot ---------- */
async function boot() {
  Connection.start();
  // A failed session read used to be indistinguishable from "not logged in", so
  // opening the app with no connection bounced you to a login page you also
  // couldn't use — reading as "signed out" when the truth was "unreachable".
  // Connection.session() returns null only for the latter.
  let session = await Connection.session();
  if (!session) {
    // Unreachable — but if this device has booted successfully before, it has
    // the session (and the mail) it booted with, and can open on that instead.
    // Only a device with nothing cached still gets the boot-offline screen,
    // which polls and reloads itself once the server answers.
    session = await Offline.cachedSession();
    if (!session) { Connection.showBootOffline(); return; }
    state.offlineBoot = true;
  }
  if (!session.loggedIn) { location.replace('/login.html'); return; }
  // Before anything reads or writes the offline store: it binds to this login,
  // and wipes itself if the last person to use this device was someone else.
  await Offline.init(session.username);
  // connection.js probes /api/session with a raw fetch — deliberately, so no
  // layer of ours can make a dead server look alive — which means the one read
  // that decides whether the app can open offline at all never passes through
  // api.js's cache hook. Hand it over explicitly.
  if (!state.offlineBoot) Offline.rememberSession(session);
  // Loads whatever was queued while this device was last offline, and rebuilds
  // the overlay that keeps those actions visible in cached listings.
  await Outbox.init();
  // #app starts `hidden` (see index.html) so a not-logged-in visitor never sees the
  // full mail UI flash before the redirect above fires — reveal it now that we
  // actually know a session exists, before the rest of boot() renders into it.
  $('#app').hidden = false;
  // displayUsername preserves the case actually typed at signup/rename (see
  // server/session.js) — login itself stays case-insensitive either way
  // (matched against the lowercase-normalized username under the hood).
  state.username = session.displayUsername || session.username;
  state.session = session;
  $('#btn-logout').addEventListener('click', async () => {
    // Anything still queued is about to become unreachable: logging out is the
    // last moment somebody can be told, and sending it after a logout is not
    // something this app should decide to do on its own.
    if (Outbox.count() && !await Dialog.confirm(
      I18n.t('{n} action(s) have not been sent yet. Logging out will discard them.').replace('{n}', Outbox.count()),
      { title: I18n.t('Log out'), okLabel: I18n.t('Log out'), danger: true })) return;
    await fetch('/api/logout', { method: 'POST' }).catch(() => {});
    // The offline store holds this person's mail in plain form on this device.
    // Logging out is the one unambiguous "I am done here", so it goes — a
    // session that merely expired does not wipe it (see api.js's 401 path),
    // because re-logging in as the same user should not cost a re-download.
    await Offline.wipe();
    location.replace('/login.html');
  });
  applyUsername();
  if (session.version) $('#brand-version').textContent = 'v' + session.version;

  state.settings = await API.settings();
  applyDeviceSettings();
  // language chosen on the login page wins the first time, then it's a setting
  const loginLang = localStorage.getItem('hmelj-lang');
  if (loginLang && loginLang !== state.settings.language) {
    state.settings = await saveServerSettings({ language: loginLang }).catch(() => state.settings);
  }
  localStorage.removeItem('hmelj-lang');
  await I18n.init(state.settings.language);
  // Before applyUiFont() — migrateFontValue() (used there) needs to already
  // know the custom-font list to correctly keep a custom family selected
  // instead of momentarily falling back to system-ui.
  // Before refreshCustomFonts, which paints the @font-face rules: the saved
  // copies have to be in memory by then, because buildFontFaceCss() reads them
  // synchronously (see messageFrame.js).
  await Offline.loadFonts();
  await refreshCustomFonts();
  applyTheme();
  applyUiFont();
  applyKeepScreenOn();
  applyReadingPane();
  applyColumnWidths();
  applyListLayout();
  initColumnResizers();
  initListHeader();
  bindToolbar();
  applyShowMuted(); // after bindToolbar, which is what sets the button's own listener
  Compose.init();
  Settings.init();
  Analytics.init();
  Calendar.init();
  // Last of the four, and deliberately: every shortcut calls into one of the
  // modules above, and its guard asks each of them whether it is open.
  Shortcuts.init();
  Settings.setAdmin(!!session.isAdmin);
  // Sidebar starts closed (overlay) on mobile, open on desktop; keep it sane
  // across viewport changes (e.g. rotating a tablet past the breakpoint).
  setSidebarOpen(!isMobileViewport());
  addEventListener('resize', () => { if (!isMobileViewport()) setSidebarOpen(true); });
  // Re-probes safe-area insets (see index.html's __applyInsets) on rotation/
  // chrome changes — but NOT on a keyboard-driven resize: an on-screen
  // keyboard opening also fires 'resize', and probing while it's open/
  // animating reads a wrong (usually collapsed) inset that nothing ever
  // corrects back afterward, unlike the startup sequence's own retries —
  // permanently squashing the safe-area padding until a reload.
  addEventListener('resize', () => {
    if (typeof window.__applyInsets !== 'function') return;
    const el = document.activeElement;
    const keyboardLikelyOpen = el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable === true);
    if (keyboardLikelyOpen) return;
    setTimeout(window.__applyInsets, 200);
  });

  state.identities = await API.identities();
  state.contacts = await API.contacts();
  // Non-fatal, both: a failure here costs the sidebar its saved-search rows or
  // the composer its group tokens, neither of which is a reason to stop the app
  // from loading mail.
  state.savedSearches = await API.savedSearches().catch(() => []);
  state.contactGroups = await API.contactGroups().catch(() => []);
  Compose.setTemplates(await API.templates().catch(() => []));
  await refreshSnoozed();

  state.accounts = await API.accounts();
  applyAccountGate();
  if (!state.accounts.length) {
    // First run for this user: offer the wizard straight away.
    renderAccounts();
    const added = await Settings.accountWizard();
    if (!added) {
      // Cancelled — which is allowed. applyAccountGate() has already put the app
      // in its no-mailbox state: the list explains what is missing and offers the
      // wizard again, and every mail action does the same. Stop here rather than
      // loading mail there is none of.
      return;
    }
    state.accounts = await API.accounts();
    state.identities = await API.identities();
    applyAccountGate();
  }
  // After state.accounts resolves either way (not before — see the
  // reported bug) — Compose.setIdentities groups the From dropdown by
  // account (an <optgroup> per account, matched via each identity's own
  // accountId against state.accounts), so calling it while state.accounts
  // was still empty/undefined made every identity fail to match any
  // account and land in a single "Other" catch-all group instead.
  Compose.setIdentities(state.identities);

  const active = activeAccounts();
  // active[0]?.id falls back to 'all' when every account is disabled — an
  // edge case, but must not crash (unified view over zero accounts just
  // shows nothing, rather than throwing on active[0] being undefined).
  state.currentAccount = active.length > 1 ? 'all' : (active[0]?.id || 'all');
  API.account = state.currentAccount === 'all' ? null : state.currentAccount;
  const savedLast = localStorage.getItem('hmelj-last-account');
  state.lastAccount = state.currentAccount !== 'all' ? state.currentAccount
    : (active.some((a) => a.id === savedLast) ? savedLast : active[0]?.id);
  renderAccounts();

  const conn = $('#conn-status');
  conn.classList.add('ok');
  conn.title = active.map((a) => a.label).join(', ') || I18n.t('No active mail accounts');

  await loadFolders();
  await openFolder('INBOX');
  // Establishes the hardware-back trap even if the very first back press
  // ever happens before any other navigation — without this, a fresh
  // launch sitting at rest has no history entry of ours to catch that
  // press at all yet (see the block above closeMessage()).
  navPush();

  // periodic refresh of folder counts — skipped entirely while the server is
  // unreachable, so an outage doesn't turn into a "Cannot load folders" toast
  // every 90 seconds on top of the banner that already says so. The reconnect
  // handler (Connection.onChange) runs a full refresh anyway.
  setInterval(() => { if (Connection.isOnline()) loadFolders(); }, 90 * 1000);
  // Sidebar 🔕 markers: fetch the holiday calendar once (for schedules with
  // "skip holidays"), then re-evaluate every minute so a schedule boundary
  // flips the markers on its own, with nobody touching the sidebar.
  ensureSilenceHolidays();
  // Paints the Scheduled badge on first load. Also re-run after anything that
  // changes the queue (scheduling from compose, cancelling from the list).
  refreshScheduled();
  setInterval(updateSilenceMarkers, 60 * 1000);
  // background-sync indicator + auto-refresh when the server finds new mail
  startSyncStatusPolling();
  connectEvents(); // instant cross-device sync — see the block above the offline/online listeners

  /* ---------- offline mode ---------- */
  // Whether there is anything saved to read at all decides what the offline
  // banner says, so it is answered once here rather than guessed at each time.
  state.offlineHasCache = state.offlineBoot || (await Offline.envelopes()).length > 0;
  Outbox.onChange(() => { paintOutboxBadge(); updateOfflineBanner(); });
  paintOutboxBadge();
  updateOfflineBanner();
  applyOfflineAffordances();
  if (Connection.isOnline()) {
    // An online boot has just done everything a reconnect refresh would do, so
    // it counts as one: a connection that flickers in the next half minute
    // defers its refresh instead of repeating the whole load. An OFFLINE boot
    // deliberately does not set this — there, coming back really is the first
    // time anything has been read from the server.
    lastReconnectAt = Date.now();
    // A queue left over from the last time this device was offline — including
    // one left by a tab that was closed before it could drain.
    flushOutbox();
    // And then fill the cache, well after the app has finished painting: this
    // is a background download, and the first seconds after boot belong to the
    // person waiting for their inbox.
    Offline.schedulePrefetch(8000);
    // Same reasoning, same delay class: a font file is a few hundred kilobytes
    // and nothing on screen is waiting for it. Deliberately not inside
    // refreshCustomFonts(), which runs while the inbox is still loading.
    setTimeout(ensureOfflineFonts, 6000);
  }
  // Outside the branch above, and it has to be: a session that BOOTED offline
  // still wants the top-up once the connection comes back, and a timer only
  // started on an online boot would never exist to do it. The guard inside is
  // what makes that safe.
  // A quiet top-up while the app stays open, so a laptop that has been sitting
  // on a desk all afternoon is still worth closing the lid on.
  setInterval(() => { if (Connection.isOnline() && !document.hidden) Offline.prefetch(); }, 10 * 60 * 1000);
  // `desktopNotifications` is one shared setting per Hmelj login (see
  // store.js) — turning it on on one device makes the Settings checkbox
  // render pre-checked on every OTHER device too, without ever firing the
  // `change` handler that actually subscribes THIS device. A push
  // subscription is inherently per-device though, and expires on its own
  // besides (browser endpoint rotation, Android FCM token rotation). This
  // re-registers whenever the server no longer has a working registration
  // for this device — see ensurePushRegistered.
  // Caught, like the other call site: these are server round trips (the push
  // registration asks which subscriptions the server still holds), and with no
  // connection they throw. Nothing after this point is worth failing the whole
  // boot for — least of all offline, where the app is already up and usable.
  await ensurePushRegistered().catch(() => { /* offline, or logged out — the next visibility change tries again */ });
  maybePromptNotifications();
  checkAndroidHealth();
}

/**
 * Nudge the one Android setting that most often silently breaks background
 * notifications. The native shell has always exposed both of these bridge
 * methods and declares the permission, but nothing ever called them — so no
 * user was ever offered the Doze exemption, which on Xiaomi/Huawei/Oppo/
 * Samsung is a leading cause of high-priority data pushes simply never being
 * delivered to a backgrounded app.
 *
 * Asked at most once per install; declining is remembered so this never
 * becomes nagging.
 */
function checkAndroidHealth() {
  const bridge = window.AndroidApp;
  if (!bridge?.isIgnoringBatteryOptimizations || !state.settings?.desktopNotifications) return;
  if (localStorage.getItem('hmelj-battery-prompted')) return;
  let exempt = true;
  try { exempt = !!bridge.isIgnoringBatteryOptimizations(); } catch { return; }
  if (exempt) return;
  localStorage.setItem('hmelj-battery-prompted', '1');
  toast(I18n.t('Android may delay new-mail notifications for this app. Tap to allow background delivery.'), 12000, () => {
    try { bridge.requestIgnoreBatteryOptimizations(); } catch { /* OEM blocked the intent — the bridge falls back to the settings screen itself */ }
  });
}

/* ---------- native (Android shell) callbacks ----------
 * The shell calls these on the page; both were previously undefined here, so
 * the native side's work was silently discarded.
 *
 * onCodexaPushToken is the important one: FCM rotates a device's token
 * (reinstall, app-data clear, periodic refresh) and the shell forwards the new
 * one here. With no listener, the server kept pushing to the old token, FCM
 * reported it unregistered, the server pruned it — and that device never
 * received another notification, with the Settings checkbox still on. */
window.onCodexaPushToken = async (token) => {
  if (!token) return;
  try {
    await API.pushSubscribe({ type: 'fcm', token }, navigator.userAgent);
    localStorage.setItem(CODEXA_TOKEN_KEY, token);
    pushActive = true;
  } catch (e) { console.warn('Re-registering rotated FCM token failed:', e); }
};

/** Tapping a native notification hands its routing data here (the same payload
 * sw.js gets) — the browser equivalent of the ?msgAccount= deep link handled at
 * the bottom of this file. */
window.onCodexaPushTapped = (data) => {
  const d = typeof data === 'string' ? (() => { try { return JSON.parse(data); } catch { return null; } })() : data;
  if (!d) return;
  // A calendar reminder carries no folder at all, so the mail check below would
  // silently swallow it — the tap would do nothing and nothing would say why.
  if (d.kind === 'calendar') { openFolder(CALENDAR_FOLDER); return; }
  if (!d.folder || d.uid === undefined) return;
  openMessageDeepLink(d.accountId, d.folder, d.uid);
};

/** Offer the browser's native notification-permission prompt once per
 * device on first load — same pattern Telegram Web/WhatsApp Web use —
 * rather than making the user dig into Settings to discover the feature
 * exists. Only actually asks once: if the user dismisses without choosing,
 * Notification.permission stays 'default' forever and we'd otherwise ask
 * again on every reload, so a localStorage flag remembers "already
 * offered" independently of what they actually decided. Granting here
 * flips the desktopNotifications setting on to match; declining leaves it
 * off but doesn't prevent turning it on later from Settings > General,
 * which asks again itself since permission is still 'default' at that point. */
async function maybePromptNotifications() {
  if (typeof Notification === 'undefined') return;
  if (Notification.permission !== 'default') return;
  if (localStorage.getItem('hmelj-notif-prompted')) return;
  await enableNotifications();
  // Latched AFTER the attempt, not before: the flag is meant to record "we
  // already asked", and setting it first meant an attempt that never actually
  // reached a prompt (Safari refuses requestPermission() outside a user
  // gesture outright, and Chrome can apply quiet UI) was permanently recorded
  // as asked — so that device could never be offered notifications again.
  if (Notification.permission !== 'default') localStorage.setItem('hmelj-notif-prompted', '1');
}

/* ---------- resizable columns ---------- */
function applyColumnWidths() {
  const s = state.settings;
  document.documentElement.style.setProperty('--folder-col', (s.folderColWidth || 232) + 'px');
  document.documentElement.style.setProperty('--list-col', (s.listColWidth || 420) + 'px');
  document.documentElement.style.setProperty('--col-from', (s.listColFrom || 170) + 'px');
  document.documentElement.style.setProperty('--col-date', (s.listColDate || 92) + 'px');
}

/** Pointer-capture drag-to-resize for a CSS var, persisted (debounced) to a settings key. */
function makeColumnDragger() {
  let saveTimer;
  return (el, cssVar, min, max, settingKey, sign = 1) => {
    if (!el) return;
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      el.setPointerCapture(e.pointerId);
      el.classList.add('dragging');
      const startX = e.clientX;
      const startW = state.settings[settingKey] || parseInt(getComputedStyle(document.documentElement).getPropertyValue(cssVar)) || min;
      const move = (ev) => {
        const w = Math.min(max, Math.max(min, startW + sign * (ev.clientX - startX)));
        state.settings[settingKey] = w;
        document.documentElement.style.setProperty(cssVar, w + 'px');
      };
      const up = () => {
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', up);
        el.classList.remove('dragging');
        clearTimeout(saveTimer);
        saveTimer = setTimeout(() => API.saveSettings({ [settingKey]: state.settings[settingKey] }).catch(() => {}), 800);
      };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
    });
  };
}

function initColumnResizers() {
  const drag = makeColumnDragger();
  drag($('#resizer-sidebar'), '--folder-col', 160, 420, 'folderColWidth');
  drag($('#resizer-list'), '--list-col', 280, 720, 'listColWidth');
}

/** Message-list header: click a column to sort by it, drag its edge to resize. */
function initListHeader() {
  const drag = makeColumnDragger();
  drag($('.col-resize[data-col="from"]'), '--col-from', 90, 320, 'listColFrom', 1);
  drag($('.col-resize[data-col="date"]'), '--col-date', 70, 200, 'listColDate', -1);
  for (const el of $$('.col-head')) {
    el.addEventListener('click', async (e) => {
      if (e.target.closest('.col-resize')) return;
      const field = el.dataset.sort;
      const dir = state.settings.sortBy === field
        ? (state.settings.sortDir === 'asc' ? 'desc' : 'asc')
        : (field === 'date' ? 'desc' : 'asc');
      state.settings = await saveServerSettings({ sortBy: field, sortDir: dir });
      renderList();
    });
  }
}

// PWA shortcut: /?compose=1 opens a blank composer
if (new URLSearchParams(location.search).get('compose')) {
  addEventListener('load', () => setTimeout(() => Compose.open(), 300));
}

// Notification deep link: sw.js opens /?msgAccount=&msgFolder=&msgUid= when
// a notification is tapped and no existing Hmelj tab was found to hand the
// message to directly instead (see openMessageDeepLink + the SW's
// 'notificationclick' handler). Same 300ms settle delay as ?compose=1 above
// — boot() needs to have picked an account/loaded folders first.
{
  const qs = new URLSearchParams(location.search);
  const msgAccount = qs.get('msgAccount'), msgFolder = qs.get('msgFolder'), msgUid = qs.get('msgUid');
  if (msgAccount && msgFolder && msgUid !== null) {
    addEventListener('load', () => setTimeout(() => openMessageDeepLink(msgAccount, msgFolder, msgUid), 300));
  }
  // The same thing for a tapped calendar reminder, which sw.js opens as
  // /?view=calendar when it found no tab to hand the event to instead.
  if (qs.get('view') === 'calendar') {
    addEventListener('load', () => setTimeout(() => openFolder(CALENDAR_FOLDER), 300));
  }
}

boot().catch((e) => {
  // #app is revealed as soon as a session is known, so its being visible means
  // the mail UI is up and working and whatever failed was one of boot's late,
  // optional steps. Covering a usable mail client with a full-screen "no
  // connection" panel over that would be far worse than the failure itself.
  if (!$('#app').hidden) {
    console.error('boot failed after the app was up', e);
    // Offline, the banner already says why and there is nothing to act on.
    if (Connection.isOnline()) toast('Startup error: ' + e.message, 8000);
    return;
  }
  // Nothing on screen at all. Unreachable here means this device has nothing
  // cached to open with (a first run with no connection, a cleared browser
  // store) — which is exactly what the boot-offline screen says, and it
  // reloads by itself the moment the server answers.
  if (!Connection.isOnline()) return Connection.showBootOffline();
  toast('Startup error: ' + e.message, 8000);
});
