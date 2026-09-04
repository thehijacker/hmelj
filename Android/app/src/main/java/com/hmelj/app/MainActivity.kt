package com.hmelj.app

import android.annotation.SuppressLint
import android.app.Activity
import android.app.PendingIntent
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.content.pm.ActivityInfo
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.os.PowerManager
import android.provider.MediaStore
import android.provider.Settings
import android.view.KeyEvent
import android.view.View
import android.view.WindowManager
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import android.webkit.MimeTypeMap
import android.webkit.URLUtil
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.browser.customtabs.CustomTabsIntent
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.FileProvider
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView

    /** Set to true by the JS bridge when the reader activates volume-key navigation. */
    @Volatile
    private var volumeKeyModeEnabled = false

    /** True when addDocumentStartJavaScript isn't supported, so the shim must be re-injected per page load. */
    private var notificationShimNeedsFallbackInjection = false

    /** Routing data from a tapped push notification, waiting for the page to finish loading. */
    private var pendingPushTapData: String? = null

    /** True while the WebView is showing the bundled offline stand-in rather than
     *  the app itself — see showOfflinePage(). */
    private var showingOfflinePage = false

    // Track back-press timing: second back press within 2 s opens server select
    private var lastBackPressTime = 0L

    // Launcher for ServerSelectActivity — handles both first-run and change-server flows
    private val serverSelectLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        if (result.resultCode == Activity.RESULT_OK) {
            val url = result.data?.getStringExtra(ServerSelectActivity.RESULT_URL) ?: return@registerForActivityResult
            saveUrl(url)
            loadServerUrl(url)
        } else if (getSavedUrl() == null) {
            // First run and user somehow cancelled — show it again (non-cancellable)
            openServerSelect(cancellable = false)
        }
    }

    // -------------------------------------------------------------------------
    // <input type="file"> support. Without onShowFileChooser() + this launcher,
    // the WebView silently drops every file pick (book / font / dictionary upload).
    // -------------------------------------------------------------------------
    private var fileChooserCallback: ValueCallback<Array<Uri>>? = null

    private val fileChooserLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        // parseResult handles cancel (returns null) and multi-select via clipData.
        val uris = WebChromeClient.FileChooserParams.parseResult(result.resultCode, result.data)
        fileChooserCallback?.onReceiveValue(uris)
        fileChooserCallback = null
    }

    // -------------------------------------------------------------------------
    // Notification permission (Android 13+ requires runtime consent before any
    // notification, including local ones posted via the JS bridge, can show).
    // -------------------------------------------------------------------------
    private val notificationPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        // Resolve the pending Notification.requestPermission() Promise(s) in the shim.
        webView.evaluateJavascript(
            "if(typeof window.__codexaNotifPermissionResult==='function') window.__codexaNotifPermissionResult($granted);",
            null
        )
    }

    // -------------------------------------------------------------------------
    // JS bridge — exposed to JavaScript as window.AndroidApp (and, for backward
    // compatibility with existing Codexa web UI code, also as window.AndroidCodexa —
    // both names point at the same object, so new template apps can standardize on
    // AndroidApp while older integrations keep working unchanged).
    // -------------------------------------------------------------------------
    inner class JsBridge {

        /** Called by the web reader to enable or disable volume-key page navigation. */
        @JavascriptInterface
        fun setVolumeKeyMode(enabled: Boolean) {
            volumeKeyModeEnabled = enabled
        }

        /** Returns the app version string so the web side can gate features. */
        @JavascriptInterface
        fun getAppVersion(): String = BuildConfig.VERSION_NAME

        /**
         * Stop the screen dimming and locking while the app is open, or let it
         * behave normally again — the web app's "Keep the screen on" setting.
         *
         * This bridge is the ONLY way the page can ask for it here: Android's
         * WebView does not implement the Screen Wake Lock API at all
         * (navigator.wakeLock is undefined in every version), so the same web
         * code that works in Chrome does nothing inside this shell.
         *
         * The flag is added in onCreate so the default is unchanged; this only
         * ever reflects what the page asks for afterwards.
         */
        @JavascriptInterface
        fun setKeepScreenOn(enabled: Boolean) {
            // @JavascriptInterface methods arrive on a binder thread, and window
            // flags are UI-thread-only.
            runOnUiThread {
                if (enabled) window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                else window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            }
        }

        /** Can be called from web JS to open the change-server screen. */
        @JavascriptInterface
        fun changeServer() {
            runOnUiThread { openServerSelect(cancellable = true) }
        }

        /** The bundled offline page's "Try again" button — reloads the configured
         *  server URL. Its own page can't do this itself: it's a file:// asset and
         *  has no idea what the server address is. */
        @JavascriptInterface
        fun retryConnection() {
            runOnUiThread { getSavedUrl()?.let { loadServerUrl(it) } ?: openServerSelect(cancellable = false) }
        }

        /** The server address currently configured, so the offline page can show
         *  WHICH server it can't reach — the single most useful thing to know when
         *  the answer is "you're on the wrong Wi-Fi" or "the VPN is down". */
        @JavascriptInterface
        fun getServerUrl(): String = getSavedUrl() ?: ""

        /**
         * Open a URL in a real browser, outside this WebView. Used by OAuth
         * sign-in (public/js/oauth.js).
         *
         * This is not a preference, it's a requirement: Google answers
         * `403 disallowed_useragent` for OAuth started in an embedded WebView,
         * and Microsoft is moving the same way. On top of that this app never
         * calls setSupportMultipleWindows(true), so the page's own
         * window.open() is silently inert here and cannot be the mechanism.
         *
         * A Custom Tab keeps the user's existing browser sign-in session and
         * comes back to Hmelj when dismissed, which a full browser hand-off
         * doesn't — hence the preference order. The page is polling
         * /api/oauth/status throughout, so it finishes on its own whichever
         * of the two the device ends up using.
         *
         * https only, deliberately: this bridge is reachable from page JS, and
         * it must not become a general-purpose intent launcher.
         */
        @JavascriptInterface
        fun openExternal(url: String) {
            val uri = try { Uri.parse(url) } catch (e: Exception) { return }
            if (!uri.scheme.equals("https", ignoreCase = true)) return
            runOnUiThread {
                try {
                    CustomTabsIntent.Builder()
                        .setShowTitle(true)
                        .build()
                        .launchUrl(this@MainActivity, uri)
                } catch (e: Exception) {
                    // No Custom Tabs provider installed (some AOSP/de-Googled
                    // devices) — the plain browser does the same job, just
                    // without returning here by itself.
                    try {
                        startActivity(Intent(Intent.ACTION_VIEW, uri))
                    } catch (e2: Exception) {
                        Toast.makeText(this@MainActivity, getString(R.string.no_browser_for_signin), Toast.LENGTH_LONG).show()
                    }
                }
            }
        }

        /**
         * Open a link from a MESSAGE in the system's default browser.
         *
         * Separate from openExternal above, and different on purpose: that one
         * is for OAuth and prefers a Custom Tab, because signing in has to come
         * back here afterwards and wants the browser's existing session. A link
         * in a newsletter is somewhere the reader is going, so it goes to
         * whatever they actually use as a browser (ACTION_VIEW) — the same
         * place shouldOverrideUrlLoading already sends any off-host navigation.
         *
         * This exists at all because window.open() is INERT in this WebView
         * (setSupportMultipleWindows is never enabled), so every link in a
         * message body quietly did nothing here.
         *
         * http and https only. Like openExternal, this bridge is reachable from
         * page JS and must not become a general-purpose intent launcher — a
         * `mailto:` is handled by the page itself (it composes in Hmelj), and
         * nothing else is a link a message may hand us.
         */
        @JavascriptInterface
        fun openLink(url: String) {
            val uri = try { Uri.parse(url) } catch (e: Exception) { return }
            val scheme = uri.scheme?.lowercase()
            if (scheme != "https" && scheme != "http") return
            runOnUiThread {
                try {
                    startActivity(Intent(Intent.ACTION_VIEW, uri))
                } catch (e: Exception) {
                    Toast.makeText(this@MainActivity, getString(R.string.no_browser_for_signin), Toast.LENGTH_LONG).show()
                }
            }
        }

        /** Called by the reader JS to enter/exit fullscreen immersive mode (hide nav bar). */
        @JavascriptInterface
        fun setReaderMode(active: Boolean) {
            runOnUiThread { setImmersiveMode(active) }
        }

        /** Lock or unlock the screen orientation to portrait. */
        @JavascriptInterface
        fun setPortraitLock(lock: Boolean) {
            runOnUiThread {
                requestedOrientation = if (lock)
                    ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
                else
                    ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
            }
        }

        /** Returns true when the user enabled e-ink mode in the server-select screen. */
        @JavascriptInterface
        fun isEinkMode(): Boolean =
            getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
                .getBoolean("eink_mode", false)

        /** Returns true when the Android system is in night/dark mode. */
        @JavascriptInterface
        fun isNightMode(): Boolean {
            val uiMode = resources.configuration.uiMode and
                    android.content.res.Configuration.UI_MODE_NIGHT_MASK
            return uiMode == android.content.res.Configuration.UI_MODE_NIGHT_YES
        }

        /** Persists e-ink mode so the login-page toggle stays in sync with server-select. */
        @JavascriptInterface
        fun setEinkMode(enabled: Boolean) {
            getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
                .edit().putBoolean("eink_mode", enabled).apply()
        }

        /**
         * Called by web JS whenever it applies/resolves a theme, so the system status bar
         * and navigation bar icon color can be flipped to match. The WebView content's theme
         * (day/night/eink/sepia/...) is decided entirely in CSS/JS and the native shell has no
         * other way to learn it — without this, system bar icons stay whatever color they
         * defaulted to (independent of the in-app theme) and can become invisible against it
         * (e.g. light system icons on a bright in-app background).
         */
        @JavascriptInterface
        fun setStatusBarAppearance(light: Boolean) {
            runOnUiThread {
                val controller = WindowInsetsControllerCompat(window, window.decorView)
                controller.isAppearanceLightStatusBars = light
                controller.isAppearanceLightNavigationBars = light
            }
        }

        /**
         * Called by the web app whenever it applies/resolves a theme (see app.js's
         * applyTheme()) with that theme's real `--bg` CSS color, so the native root
         * layout behind the WebView — visible only through the safe-area margin
         * setupNativeSafeAreaPadding() applies around it — matches instead of staying
         * whatever the layout XML's default background happens to be. Persisted so
         * the NEXT cold start can apply the last-known color immediately in onCreate(),
         * before the WebView has loaded far enough to call this itself again — without
         * that, every fresh launch would flash the hardcoded XML default for a moment.
         */
        @JavascriptInterface
        fun setBackgroundColor(hex: String) {
            runOnUiThread {
                try {
                    val color = android.graphics.Color.parseColor(hex)
                    findViewById<View>(R.id.rootLayout)?.setBackgroundColor(color)
                    getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
                        .edit().putString("bg_color", hex).apply()
                } catch (e: IllegalArgumentException) {
                    // Malformed color string from the web side — ignore rather than crash.
                }
            }
        }

        // ---------------------------------------------------------------
        // Notifications — gives the web app native notification control
        // (permission + posting) that a browser/PWA install can't reliably
        // offer, without requiring a full FCM/push backend integration.
        // ---------------------------------------------------------------

        /** True if this app is currently allowed to post notifications. */
        @JavascriptInterface
        fun hasNotificationPermission(): Boolean =
            NotificationManagerCompat.from(this@MainActivity).areNotificationsEnabled()

        /** Prompts the Android 13+ runtime permission dialog if not already granted; otherwise
         *  resolves immediately so the JS-side Notification.requestPermission() promise settles
         *  either way (see notificationShimJs / __codexaNotifPermissionResult). */
        @JavascriptInterface
        fun requestNotificationPermission() {
            runOnUiThread {
                if (NotificationManagerCompat.from(this@MainActivity).areNotificationsEnabled()) {
                    webView.evaluateJavascript(
                        "if(typeof window.__codexaNotifPermissionResult==='function') window.__codexaNotifPermissionResult(true);",
                        null
                    )
                } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                    notificationPermissionLauncher.launch(android.Manifest.permission.POST_NOTIFICATIONS)
                } else {
                    // Below API 33 there's no runtime dialog — notifications are governed
                    // solely by the user's per-app Settings toggle, already checked above.
                    webView.evaluateJavascript(
                        "if(typeof window.__codexaNotifPermissionResult==='function') window.__codexaNotifPermissionResult(false);",
                        null
                    )
                }
            }
        }

        /**
         * Posts a local notification. Tapping it re-opens the app. `id` lets the web app
         * reuse/replace a notification (e.g. progress updates) by posting the same id again.
         */
        @JavascriptInterface
        fun showNotification(title: String, body: String, id: Int) {
            runOnUiThread {
                if (!NotificationManagerCompat.from(this@MainActivity).areNotificationsEnabled()) return@runOnUiThread
                val tapIntent = Intent(this@MainActivity, MainActivity::class.java).apply {
                    flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
                }
                val pendingFlags = PendingIntent.FLAG_UPDATE_CURRENT or
                        (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) PendingIntent.FLAG_IMMUTABLE else 0)
                val pendingIntent = PendingIntent.getActivity(this@MainActivity, id, tapIntent, pendingFlags)

                val notification = NotificationCompat.Builder(this@MainActivity, NOTIFICATION_CHANNEL_ID)
                    .setSmallIcon(R.drawable.ic_launcher_foreground)
                    .setContentTitle(title)
                    .setContentText(body)
                    .setAutoCancel(true)
                    .setContentIntent(pendingIntent)
                    // Same group as the badge-count summary below — without this, several
                    // launchers (Samsung One UI included) sum setNumber() across EVERY
                    // active notification from the app independently, so a real mail
                    // notification sitting undismissed in the tray alongside the badge
                    // notification's own setNumber(totalUnread) inflates the shown badge
                    // past the real total. Grouped, the launcher uses the group summary's
                    // number instead of summing each child.
                    .setGroup(NEW_MAIL_GROUP)
                    .build()
                NotificationManagerCompat.from(this@MainActivity).notify(id, notification)
            }
        }

        /**
         * Keeps the launcher icon's unread-count badge showing the TRUE current
         * total. Called by the web app (see app.js's updateUnreadIndicator())
         * whenever its own computed unread total changes for ANY reason — not
         * just a new push arriving. That distinction is exactly why this exists:
         * Android's launcher badge is otherwise driven purely by the count of
         * this app's own active (undismissed) notifications, which has no way to
         * go DOWN when a message is marked read from a completely different
         * client/device — no notification for that message was ever posted here
         * to dismiss. Maintaining one silent, minimum-priority summary
         * notification whose setNumber() tracks the real total instead (most
         * launchers, Samsung's One UI in particular, read that value directly)
         * sidesteps the problem: it's updated/cancelled here in lockstep with
         * whatever the web app's own accurate count says, regardless of why it
         * changed. Cancelled entirely at zero rather than left showing "0".
         */
        @JavascriptInterface
        fun setUnreadBadgeCount(count: Int) {
            // Delegates to MailNotifications, so the page and the FCM service write the
            // badge through exactly the same code. The push path is the one that runs
            // when the app is closed — and before this, it couldn't touch the badge at
            // all, which is why the number went stale the moment the app wasn't open.
            runOnUiThread { MailNotifications.setBadge(this@MainActivity, count) }
        }

        // ---------------------------------------------------------------
        // Battery optimization — lets the web app ask the user to whitelist
        // this app so background sync / notification delivery isn't killed
        // by Doze on aggressive OEM battery managers.
        // ---------------------------------------------------------------

        /** True if this app is already exempt from battery optimizations. */
        @JavascriptInterface
        fun isIgnoringBatteryOptimizations(): Boolean {
            val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
            return pm.isIgnoringBatteryOptimizations(packageName)
        }

        /** Opens the system dialog to request battery optimization exemption for this app. */
        @JavascriptInterface
        fun requestIgnoreBatteryOptimizations() {
            runOnUiThread {
                val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
                if (!pm.isIgnoringBatteryOptimizations(packageName)) {
                    try {
                        startActivity(Intent(
                            Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                            Uri.parse("package:$packageName")
                        ))
                    } catch (e: Exception) {
                        // Some OEM ROMs block this intent — fall back to the general battery settings screen.
                        try {
                            startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
                        } catch (e2: Exception) { /* nothing more we can do */ }
                    }
                }
            }
        }

        // ---------------------------------------------------------------
        // Real push (Firebase Cloud Messaging) — works even while the app
        // process is fully closed, unlike the local-only showNotification()
        // above. See TEMPLATE_README.md "Real push notifications (FCM)".
        // ---------------------------------------------------------------

        /** Whether this build has Firebase configured at all (app/google-services.json present). */
        @JavascriptInterface
        fun isPushSupported(): Boolean = BuildConfig.PUSH_ENABLED

        /**
         * Asynchronously fetches (or generates) this device's FCM registration token and
         * resolves it back into the page via window.__codexaPushTokenResult(token|null) —
         * see the injected CodexaPush.subscribe() helper in notificationShimJs. Send this
         * token to your backend and call the Firebase Admin SDK's messaging().send({token, ...})
         * to push to this specific device.
         */
        @JavascriptInterface
        fun requestPushToken() {
            runOnUiThread {
                if (!BuildConfig.PUSH_ENABLED) {
                    deliverPushTokenToJs(null)
                    return@runOnUiThread
                }
                try {
                    com.google.firebase.messaging.FirebaseMessaging.getInstance().token
                        .addOnCompleteListener { task ->
                            val token = if (task.isSuccessful) task.result else null
                            if (token != null) {
                                getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
                                    .edit().putString("fcm_token", token).apply()
                            }
                            deliverPushTokenToJs(token)
                        }
                } catch (e: Exception) {
                    // Firebase not actually initialized (e.g. no google-services.json at
                    // build time despite PUSH_ENABLED somehow being true) — fail soft.
                    deliverPushTokenToJs(null)
                }
            }
        }

        /**
         * Hands a server-hosted attachment to the operating system: downloads it
         * with this app's session cookie and opens the system "Open with…"
         * chooser for it (see openAttachmentFromServer).
         *
         * Called by the web app's attachment viewer on mobile
         * (public/js/attachmentViewer.js#handOffToOS) instead of trying to render
         * the file itself — a WebView cannot draw a PDF, and the page has no way
         * to authenticate a download on its own: the session cookie is HttpOnly,
         * so only native code can read it out of the CookieManager.
         */
        @JavascriptInterface
        fun openAttachment(url: String, filename: String, mime: String) {
            // @JavascriptInterface methods arrive on a binder thread; the flow
            // below touches the WebView and posts a Toast, both of which are
            // UI-thread-only (same reason requestPushToken() hops first).
            runOnUiThread { openAttachmentFromServer(url, filename, mime) }
        }
    }

    // -------------------------------------------------------------------------
    // Activity lifecycle
    // -------------------------------------------------------------------------

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // On by default, which is what this has always done — the web app turns it
        // off through the bridge (JsBridge.setKeepScreenOn) if its "Keep the screen
        // on" setting says so, right after it boots. Set here rather than waiting for
        // the page, so the behaviour is unchanged for the seconds before it loads and
        // for a page that never calls in at all.
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        // Stay edge-to-edge for the entire lifetime of the activity.
        // We never re-enable fitSystemWindows because toggling it causes
        // a layout jump (blank gap below the status bar) when leaving the reader.
        WindowCompat.setDecorFitsSystemWindows(window, false)

        // Theme.AppCompat.DayNight (see themes.xml) isn't edge-to-edge aware on its
        // own and defaults navigationBarColor/statusBarColor to a solid color (white
        // in light mode) — Chrome sets this itself, which is why the same page looks
        // right in a Chrome tab but not here without doing it ourselves too. With
        // decorFitsSystemWindows already false, transparent is correct regardless of
        // whether the bar itself is currently shown or hidden.
        window.navigationBarColor = android.graphics.Color.TRANSPARENT
        window.statusBarColor = android.graphics.Color.TRANSPARENT

        // Required for the window to actually be allowed to extend into the physical
        // camera-cutout area at all (independent of whether the status bar itself is
        // shown or hidden) — without this, on API 28+ the reported displayCutout()
        // inset can come back as 0 / the cutout area is simply avoided instead of
        // exposed to us, which is exactly wrong when IMMERSIVE_MODE hides the status
        // bar full-time, as it does here: once the status bar is gone
        // there's no other signal telling the system this window wants the cutout
        // area at all. SHORT_EDGES (not ALWAYS) is Google's recommended mode for apps
        // that handle their own insets via WindowInsetsCompat, as setupNativeSafeAreaPadding()
        // below does.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            window.attributes = window.attributes.apply {
                layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
            }
        }

        if (BuildConfig.DEBUG) {
            WebView.setWebContentsDebuggingEnabled(true)
        }

        setContentView(R.layout.activity_main)
        webView = findViewById(R.id.webView)

        // Apply the last theme color the web app told us about (see
        // JsBridge.setBackgroundColor()) immediately, before the WebView has loaded
        // far enough to call that itself again — without this, every fresh launch
        // would flash the layout XML's hardcoded default behind the safe-area margin
        // for a moment first. No-op (keeps the XML default) on a genuinely first-ever
        // launch, where nothing has been persisted yet.
        getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE).getString("bg_color", null)?.let { hex ->
            try {
                findViewById<View>(R.id.rootLayout)?.setBackgroundColor(android.graphics.Color.parseColor(hex))
            } catch (e: IllegalArgumentException) { /* stale/invalid saved value — ignore */ }
        }

        onBackPressedDispatcher.addCallback(this, onBackCallback)

        createNotificationChannel()
        configureWebView()
        setImmersiveMode(shouldBeImmersive(null))

        // If this cold-start was triggered by tapping a push notification, stash the
        // routing data (e.g. {accountId, folder, uid}) — delivered to the page once it's
        // actually loaded and ready, in onPageFinished below.
        pendingPushTapData = intent.getStringExtra(EXTRA_PUSH_DATA)

        val savedUrl = getSavedUrl()
        if (savedUrl != null) {
            loadServerUrl(savedUrl)
        } else {
            openServerSelect(cancellable = false)
        }
    }

    // The app was already running (in the background or foreground) and the user tapped a
    // push notification — onCreate() does NOT run again in that case, only this.
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        intent.getStringExtra(EXTRA_PUSH_DATA)?.let { deliverPushTapToJs(it) }
    }

    override fun onResume() {
        super.onResume()
        activeInstance = this
        webView.onResume()
        registerNetworkCallback()
        // Second safety net alongside onWindowFocusChanged for reasserting immersive
        // mode: Android can reset the hidden-bars state on screen-off/wake independent
        // of any focus-change callback firing correctly, so hiding only on focus-regain
        // isn't quite enough on its own — this covers the screen-wake case specifically.
        setImmersiveMode(shouldBeImmersive(webView.url))
        // Trigger sync in case the device was offline while sleeping and is now
        // connected — including retrying the load outright if we're sitting on the
        // offline page. (Also no longer gated on isOnReader(); see the network
        // callback's own note.)
        triggerNetworkRestoreSync()
        // Re-assert this device's push registration on every foreground. Cheap
        // (WorkManager coalesces on a unique name) and it's what repairs an install
        // whose token rotated while the app was closed — including installs that
        // predate PushTokenWorker and have been silently unregistered for a while.
        if (BuildConfig.PUSH_ENABLED) reRegisterPushToken()
    }

    /** Ask FCM for the current token and hand it to PushTokenWorker to upload. */
    private fun reRegisterPushToken() {
        try {
            com.google.firebase.messaging.FirebaseMessaging.getInstance().token
                .addOnCompleteListener { task ->
                    val token = if (task.isSuccessful) task.result else null
                    if (!token.isNullOrEmpty()) {
                        getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
                            .edit().putString("fcm_token", token).apply()
                        PushTokenWorker.enqueue(applicationContext, token)
                    }
                }
        } catch (e: Exception) {
            // Firebase not initialized for this build — nothing to register.
        }
    }

    override fun onPause() {
        super.onPause()
        if (activeInstance === this) activeInstance = null
        // Pause the WebView so its JS timers (clock / battery refresh, etc.) stop while the
        // app is backgrounded — saves power on e-ink devices when the cover is closed.
        webView.onPause()
        unregisterNetworkCallback()
        // Persist cookies to disk now. Nothing in this app touched CookieManager before,
        // so the session cookie lived only in memory: it died with the process, and a
        // push-triggered cold start then landed on the login screen with no mail and no
        // badge. PushTokenWorker also reads this cookie to authenticate its upload, so
        // it has to survive the process too.
        CookieManager.getInstance().flush()
    }

    override fun onDestroy() {
        // Detach and destroy the WebView to release its resources and avoid leaks.
        (webView.parent as? android.view.ViewGroup)?.removeView(webView)
        webView.destroy()
        super.onDestroy()
    }

    // The system can re-show the status/nav bars on its own whenever this window regains
    // focus (backgrounding via home button / recents / notification shade / a system dialog,
    // then returning) — hiding them once in onPageStarted/onPageFinished isn't enough to keep
    // them hidden across that. Reasserting here on every focus-regain is the documented fix
    // for immersive mode "not sticking" after the app comes back from the background.
    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) {
            setImmersiveMode(shouldBeImmersive(webView.url))
        }
    }

    // -------------------------------------------------------------------------
    // Network callback — triggers KOSync when connectivity is restored
    // -------------------------------------------------------------------------

    private var connectivityManager: ConnectivityManager? = null
    private var networkCallback: ConnectivityManager.NetworkCallback? = null

    /**
     * Whether the OS currently reports a network at all.
     *
     * Only used to choose the WebView's cache mode when a load STARTS (see
     * loadServerUrl). It is deliberately not treated as "the server is
     * reachable" anywhere else — that question belongs to the page, which
     * answers it from what actually happens to its own requests
     * (public/js/connection.js), and a phone on a café network with no route
     * to a home server is the case that distinction exists for.
     */
    private var hasNetwork: Boolean = true

    /** One cache-only retry per load attempt — see onReceivedError. Guards
     *  against a load that fails from the cache too turning into a loop. */
    private var cacheFallbackTried = false

    private fun registerNetworkCallback() {
        connectivityManager = getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        val request = NetworkRequest.Builder()
            .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            .build()
        hasNetwork = connectivityManager?.activeNetwork != null
        networkCallback = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                hasNetwork = true
                // Back on a real network: stop reading the app out of the HTTP
                // cache. Nothing about the offline data store changes — that
                // lives in the page's IndexedDB — but a live session must never
                // be served a stale API response from underneath it.
                runOnUiThread { webView.settings.cacheMode = WebSettings.LOAD_DEFAULT }
                // Small delay to let the network fully settle before making API calls.
                // NOT gated on isOnReader() any more — that checks for the original shell app's
                // /reader.html, a page this app never has, so the restore hook
                // could never actually fire here.
                webView.postDelayed({ triggerNetworkRestoreSync() }, 2000)
            }

            override fun onLost(network: Network) {
                hasNetwork = connectivityManager?.activeNetwork != null
                notifyNetworkLost()
            }
        }
        connectivityManager?.registerNetworkCallback(request, networkCallback!!)
    }

    private fun unregisterNetworkCallback() {
        networkCallback?.let { connectivityManager?.unregisterNetworkCallback(it) }
        networkCallback = null
    }

    /**
     * Whether the system nav/status bars should be hidden (swipe-from-edge to reveal)
     * for the given URL. Controlled by BuildConfig.IMMERSIVE_MODE:
     *   "always"      - hide on every page (what Hmelj uses)
     *   "reader_only" - only hide on a dedicated /reader.html route (inherited from
     *                   the app this WebView shell was originally written for)
     *   "never"       - never hide (normal system bars throughout)
     */
    private fun shouldBeImmersive(url: String?): Boolean = when (BuildConfig.IMMERSIVE_MODE) {
        "always" -> true
        "never" -> false
        else -> url?.contains("/reader.html", ignoreCase = true) == true // "reader_only"
    }

    /**
     * The OS says we have a network again. Two cases:
     *
     *  - the page is still loaded → poke it, so it re-probes the server and drops
     *    its offline banner without waiting for its own backoff timer. A WebView
     *    does not reliably fire the JS 'online' event, so this is the signal the
     *    page would otherwise never get.
     *  - the page IS the offline screen (the load failed outright, e.g. the app
     *    was started with no connection) → there's nothing to poke; reload the
     *    server URL for real.
     *
     * `__hmeljNetworkRestore` is the current hook name; `__codexaNetworkRestore`
     * is what this shell has always called and is kept as an alias on the page
     * side, so either version works with either version.
     */
    private fun triggerNetworkRestoreSync() {
        runOnUiThread {
            if (showingOfflinePage) {
                getSavedUrl()?.let { loadServerUrl(it) }
                return@runOnUiThread
            }
            webView.evaluateJavascript(
                "if(typeof window.__hmeljNetworkRestore==='function') window.__hmeljNetworkRestore();" +
                    "else if(typeof window.__codexaNetworkRestore==='function') window.__codexaNetworkRestore();",
                null
            )
        }
    }

    /** Counterpart for a network that just went away — lets the page show its
     *  offline state immediately instead of only finding out on its next failed
     *  request (which, on a screen the user isn't touching, may be minutes). */
    private fun notifyNetworkLost() {
        runOnUiThread {
            if (showingOfflinePage) return@runOnUiThread
            webView.evaluateJavascript(
                "if(typeof window.__hmeljNetworkLost==='function') window.__hmeljNetworkLost();",
                null
            )
        }
    }

    /**
     * Loads the real app, clearing the offline stand-in first.
     *
     * With no network, this loads it out of the WebView's own HTTP cache
     * instead of failing. That is the whole reason the app can be opened at all
     * on a flight: this shell usually points at a plain-http LAN address, which
     * is not a secure context, so there is no service worker here and none of
     * the PWA's cached shell exists. LOAD_CACHE_ELSE_NETWORK serves whatever
     * the cache holds even though it has expired, and the server marks the
     * ?v=-stamped scripts and stylesheets as immutable precisely so that they
     * are still in it (server/index.js).
     *
     * Once the app is up it reads its MAIL from its own IndexedDB store
     * (public/js/offlineDb.js), which has nothing to do with this cache — this
     * only gets the application itself onto the screen. If even that is not
     * cached (a first launch with no connection), onReceivedError still falls
     * back to the bundled offline page as it always did.
     */
    private fun loadServerUrl(url: String) {
        showingOfflinePage = false
        cacheFallbackTried = false
        webView.settings.cacheMode =
            if (hasNetwork) WebSettings.LOAD_DEFAULT else WebSettings.LOAD_CACHE_ELSE_NETWORK
        webView.loadUrl(url)
    }

    /**
     * Replaces the WebView's own "net::ERR_…" error page — which reads as a
     * broken app rather than a missing connection — with a page that says what's
     * actually wrong and offers a retry. Loaded from assets so it works with no
     * network at all, and with no service worker either: this app usually points
     * at a plain-http LAN address, which is not a secure context, so the PWA's
     * cached shell doesn't exist here.
     */
    private fun showOfflinePage() {
        showingOfflinePage = true
        webView.loadUrl("file:///android_asset/offline.html")
    }

    // Physical back behaviour (via OnBackPressedDispatcher / predictive back):
    //   - Blocked entirely when the reader is open (use the in-reader UI to exit)
    //   - Otherwise, first offered to the page itself via window.__hmeljHandleBack()
    //     (see app.js's navCollapseOneLevel()) — a page that defines it collapses its
    //     own UI one level at a time, front-to-back: whatever overlay is on top
    //     (a confirm dialog, the attachment viewer, compose — which goes through its
    //     normal save/delete/cancel prompt, never discarding a draft silently —,
    //     Settings, the user-menu sheet, the sidebar drawer), then in-page navigation
    //     (close an open message → back to the list; leave a specific account → back to
    //     "All inbox"), all before this activity's own change-server flow ever sees the
    //     press — so the hint toast below can't fire while anything is still open on
    //     top of the list. A page that doesn't
    //     define the hook just reports false/undefined
    //     here and falls straight through, unchanged from before this existed.
    //   - Double-press once truly at the root: first press shows hint toast,
    //     second press within 2 s opens server select screen.
    //   WebView history is intentionally never navigated via the hardware back key,
    //   so the callback stays enabled at all times to consume the gesture.
    private val onBackCallback = object : OnBackPressedCallback(true) {
        override fun handleOnBackPressed() {
            val currentUrl = webView.url ?: ""
            if (currentUrl.contains("/reader.html", ignoreCase = true)) {
                return
            }
            webView.evaluateJavascript(
                "(function(){try{return !!(window.__hmeljHandleBack && window.__hmeljHandleBack());}catch(e){return false;}})();"
            ) { result -> if (result != "true") runDoublePressExitFlow() }
        }
    }

    private fun runDoublePressExitFlow() {
        val now = System.currentTimeMillis()
        if (now - lastBackPressTime < 2000) {
            openServerSelect(cancellable = true)
        } else {
            lastBackPressTime = now
            Toast.makeText(this@MainActivity, getString(R.string.back_press_hint), Toast.LENGTH_SHORT).show()
        }
    }

    // -------------------------------------------------------------------------
    // Volume key interception
    // -------------------------------------------------------------------------

    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        if (!volumeKeyModeEnabled) return super.dispatchKeyEvent(event)

        val action = event.action
        val code = event.keyCode

        if (code == KeyEvent.KEYCODE_VOLUME_DOWN || code == KeyEvent.KEYCODE_VOLUME_UP) {
            if (action == KeyEvent.ACTION_UP) {
                val direction = if (code == KeyEvent.KEYCODE_VOLUME_DOWN) "down" else "up"
                webView.evaluateJavascript(
                    "if(typeof window.__codexaVolumeKey==='function') window.__codexaVolumeKey('$direction');",
                    null
                )
            }
            return true
        }

        return super.dispatchKeyEvent(event)
    }

    // -------------------------------------------------------------------------
    // WebView configuration
    // -------------------------------------------------------------------------

    @SuppressLint("SetJavaScriptEnabled")
    private fun configureWebView() {
        with(webView.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
            loadWithOverviewMode = true
            useWideViewPort = true
            setSupportZoom(true)
            builtInZoomControls = true
            displayZoomControls = false
            cacheMode = WebSettings.LOAD_DEFAULT
            userAgentString = "$userAgentString HmeljApp/${BuildConfig.VERSION_NAME}"
        }

        // Explicit rather than relying on defaults: PushTokenWorker authenticates its
        // upload with this same cookie jar from a background worker, so the session
        // cookie has to be there and has to outlive the process (flushed in onPause).
        CookieManager.getInstance().setAcceptCookie(true)
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, false)

        // "AndroidCodexa", window.CodexaPush and the window.__codexa* hooks injected
        // further down keep their names on purpose. They are a WIRE CONTRACT with
        // the web app (public/js/app.js, oauth.js, messageFrame.js,
        // attachmentViewer.js), and the two halves update independently: a phone
        // running last month's APK talks to a server deployed today, and vice
        // versa. Renaming either side alone breaks push and OAuth sign-in for
        // everyone in between. Nothing here is user-visible.
        val jsBridge = JsBridge()
        webView.addJavascriptInterface(jsBridge, "AndroidApp")
        webView.addJavascriptInterface(jsBridge, "AndroidCodexa") // back-compat alias

        // Without a DownloadListener the WebView silently drops EVERY download —
        // it ignores <a download> entirely and has nowhere else to send the
        // response, which is why the mail app's attachment "Download" button
        // appeared to do nothing at all. Catches anything the page triggers as a
        // download, including from an older web build that predates the
        // openAttachment() bridge method below.
        webView.setDownloadListener { url, _, contentDisposition, mimeType, _ ->
            openAttachmentFromServer(
                url,
                URLUtil.guessFileName(url, contentDisposition, mimeType),
                mimeType
            )
        }

        setupNativeSafeAreaPadding()
        injectNotificationShim()

        webView.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(
                webView: WebView?,
                filePathCallback: ValueCallback<Array<Uri>>?,
                fileChooserParams: FileChooserParams?
            ): Boolean {
                // Cancel any previous pending pick so its <input> isn't left hanging.
                fileChooserCallback?.onReceiveValue(null)
                fileChooserCallback = filePathCallback

                val baseIntent = fileChooserParams?.createIntent()
                    ?: Intent(Intent.ACTION_GET_CONTENT).apply {
                        type = "*/*"
                        addCategory(Intent.CATEGORY_OPENABLE)
                    }

                // Wrap with createChooser so the system picker always appears even when
                // the specific MIME types (epub, cbz, ttf…) aren't registered on the device.
                // Without this, ACTION_GET_CONTENT can silently resolve to nothing on some
                // Android 10+ devices / OEM launchers, giving the appearance that the tap
                // did nothing at all.
                val chooserIntent = Intent.createChooser(baseIntent, null)

                return try {
                    fileChooserLauncher.launch(chooserIntent)
                    true
                } catch (e: Exception) {
                    // Catch SecurityException / IllegalStateException in addition to
                    // ActivityNotFoundException — all leave the callback in a hung state
                    // on modern Android if not cleaned up here.
                    fileChooserCallback?.onReceiveValue(null)
                    fileChooserCallback = null
                    Toast.makeText(
                        this@MainActivity,
                        getString(R.string.file_chooser_unavailable),
                        Toast.LENGTH_SHORT
                    ).show()
                    false
                }
            }
        }

        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(
                view: WebView,
                request: WebResourceRequest
            ): Boolean {
                val url = request.url.toString()
                if (url.startsWith("mailto:") || url.startsWith("tel:")) {
                    startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
                    return true
                }
                // Any navigation to a host other than the configured Hmelj server
                // (e.g. a "View on BookOrbit" link) should open in the system browser
                // instead of loading inside this app's WebView.
                val serverHost = getSavedUrl()?.let { Uri.parse(it).host }
                val targetHost = request.url.host
                if (serverHost != null && targetHost != null && !targetHost.equals(serverHost, ignoreCase = true)) {
                    try {
                        startActivity(Intent(Intent.ACTION_VIEW, request.url))
                    } catch (e: Exception) {
                        // No browser available — fall through and let the WebView try.
                        return false
                    }
                    return true
                }
                return false
            }

            // Main-frame load failure = we couldn't reach the server at all
            // (no network, wrong Wi-Fi, VPN down, server off). Subresource
            // failures are ignored: a single missing image must not blow the
            // whole app away, and the page's own connection.js handles those.
            //
            // Before giving up, try once more out of the HTTP cache. "There is
            // a network but the server is not answering" — a VPN that hasn't
            // come up, a home server that is restarting, the wrong Wi-Fi — is
            // by far the most common way this app is offline, and it is exactly
            // the case the no-network check in loadServerUrl cannot see. If the
            // app is in the cache, the user gets the real thing, reading their
            // saved mail, instead of a stand-in page that can do nothing.
            override fun onReceivedError(
                view: WebView,
                request: WebResourceRequest,
                error: android.webkit.WebResourceError
            ) {
                if (!request.isForMainFrame) return
                if (request.url.toString().startsWith("file:///android_asset/")) return // the offline page itself
                val saved = getSavedUrl()
                if (!cacheFallbackTried && saved != null) {
                    cacheFallbackTried = true
                    view.settings.cacheMode = WebSettings.LOAD_CACHE_ELSE_NETWORK
                    view.loadUrl(saved)
                    return
                }
                showOfflinePage()
            }

            override fun onPageStarted(view: WebView, url: String, favicon: android.graphics.Bitmap?) {
                super.onPageStarted(view, url, favicon)
                volumeKeyModeEnabled = false
                if (notificationShimNeedsFallbackInjection) {
                    view.evaluateJavascript(notificationShimJs, null)
                }
                runOnUiThread { setImmersiveMode(shouldBeImmersive(url)) }
            }

            override fun onPageFinished(view: WebView, url: String) {
                super.onPageFinished(view, url)
                // The cache-only mode above exists to get the app onto the
                // screen with no network; it must not outlive that load. Left
                // on, every request the running app makes could be answered
                // from the HTTP cache — including API responses, behind the
                // app's back and outside its own offline store. (The server
                // also sends `Cache-Control: no-store` on /api for the same
                // reason; this is the other half of that belt.)
                view.settings.cacheMode = WebSettings.LOAD_DEFAULT
                cacheFallbackTried = false
                val immersive = shouldBeImmersive(url)
                pendingPushTapData?.let { data ->
                    deliverPushTapToJs(data)
                    pendingPushTapData = null
                }
                runOnUiThread {
                    setImmersiveMode(immersive)
                    // Legacy path: inject --sat/--sab/--sal/--sar CSS vars for a web UI
                    // that reads them itself. Hmelj pads the WebView natively instead
                    // (see setupNativeSafeAreaPadding()), so this only runs when
                    // BuildConfig.NATIVE_SAFE_AREA_INSETS is off.
                    if (!BuildConfig.NATIVE_SAFE_AREA_INSETS && !immersive) {
                        val rootInsets = ViewCompat.getRootWindowInsets(view)
                        if (rootInsets != null) {
                            val density = resources.displayMetrics.density
                            val combined = WindowInsetsCompat.Type.statusBars() or
                                    WindowInsetsCompat.Type.displayCutout()
                            val topPx = rootInsets.getInsets(combined).top
                            if (topPx > 0) {
                                val cssVal = String.format(java.util.Locale.ROOT, "%.2f", topPx / density)
                                view.evaluateJavascript(
                                    "document.documentElement.style.setProperty('--sat','${cssVal}px');",
                                    null
                                )
                            }
                            val nav = rootInsets.getInsets(WindowInsetsCompat.Type.navigationBars())
                            if (nav.bottom > 0) {
                                val v = String.format(java.util.Locale.ROOT, "%.2f", nav.bottom / density)
                                view.evaluateJavascript(
                                    "document.documentElement.style.setProperty('--sab','${v}px');", null)
                            }
                            if (nav.left > 0) {
                                val v = String.format(java.util.Locale.ROOT, "%.2f", nav.left / density)
                                view.evaluateJavascript(
                                    "document.documentElement.style.setProperty('--sal','${v}px');", null)
                            }
                            if (nav.right > 0) {
                                val v = String.format(java.util.Locale.ROOT, "%.2f", nav.right / density)
                                view.evaluateJavascript(
                                    "document.documentElement.style.setProperty('--sar','${v}px');", null)
                            }
                        }
                    }
                }
            }
        }
    }

    // -------------------------------------------------------------------------
    // Attachments: download with the session cookie, then "Open with…"
    //
    // Two entry points, one flow: the DownloadListener registered in
    // configureWebView() (anything the page triggers as a download) and the
    // JsBridge.openAttachment() method the web attachment viewer calls directly
    // on mobile.
    //
    // Why the file is fetched here rather than handed to DownloadManager
    // directly: DownloadManager runs in a separate system process with its own,
    // empty cookie jar, so it would request /api/... unauthenticated and
    // cheerfully save the login page as "invoice.pdf". The cookie has to be
    // copied across explicitly — same pattern PushTokenWorker already uses for
    // its own background calls.
    // -------------------------------------------------------------------------

    /** Cached downloads live here — app-private, wiped by "clear cache", and the
     *  only path exposed through the FileProvider (res/xml/file_paths.xml). */
    private fun attachmentsDir(): File = File(cacheDir, "attachments").apply { mkdirs() }

    /** Keeps the cache from growing without bound: anything older than a day is
     *  gone by the next time an attachment is opened. */
    private fun pruneOldAttachments() {
        val cutoff = System.currentTimeMillis() - 24 * 60 * 60 * 1000L
        attachmentsDir().listFiles()?.forEach { if (it.lastModified() < cutoff) it.delete() }
    }

    /** Filesystem-safe, path-traversal-safe name derived from the mail's own. */
    private fun safeFileName(filename: String, url: String): String {
        val raw = filename.ifBlank { URLUtil.guessFileName(url, null, null) }
        val cleaned = raw.substringAfterLast('/').substringAfterLast('\\')
            .replace(Regex("[^A-Za-z0-9._\\-() ]"), "_")
            .take(120)
        return cleaned.ifBlank { "attachment" }
    }

    /** Falls back to the file extension when the server sent nothing useful:
     *  most viewers simply won't appear in the chooser for an ACTION_VIEW typed
     *  as application/octet-stream, so a correct guess is what makes "Open
     *  with…" list a PDF reader at all. */
    private fun resolveMime(mime: String, filename: String): String {
        if (mime.isNotBlank() && mime != "application/octet-stream") return mime
        val ext = filename.substringAfterLast('.', "").lowercase()
        return MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext) ?: "application/octet-stream"
    }

    private fun openAttachmentFromServer(url: String, filename: String, mime: String) {
        val name = safeFileName(filename, url)
        val type = resolveMime(mime, name)
        val cookie = CookieManager.getInstance().getCookie(url)
        val ua = webView.settings.userAgentString
        Toast.makeText(this, getString(R.string.attachment_downloading), Toast.LENGTH_SHORT).show()
        Thread {
            var file: File? = null
            try {
                pruneOldAttachments()
                val conn = (URL(url).openConnection() as HttpURLConnection).apply {
                    requestMethod = "GET"
                    instanceFollowRedirects = true
                    if (!cookie.isNullOrEmpty()) setRequestProperty("Cookie", cookie)
                    setRequestProperty("User-Agent", ua)
                    connectTimeout = 20000
                    readTimeout = 60000
                }
                val code = conn.responseCode
                if (code in 200..299) {
                    val target = File(attachmentsDir(), name)
                    conn.inputStream.use { input -> target.outputStream().use { out -> input.copyTo(out) } }
                    file = target
                }
                conn.disconnect()
            } catch (e: Exception) {
                file = null
            }
            val saved = file
            runOnUiThread {
                if (saved == null || !saved.exists() || saved.length() == 0L) {
                    Toast.makeText(this, getString(R.string.attachment_failed), Toast.LENGTH_LONG).show()
                    return@runOnUiThread
                }
                openWithChooser(saved, type)
            }
        }.start()
    }

    /** Hands the saved file to whatever app the user picks. The content:// URI
     *  plus FLAG_GRANT_READ_URI_PERMISSION is what makes it readable outside this
     *  app at all — a file:// URI throws FileUriExposedException on Android 7+. */
    private fun openWithChooser(file: File, mime: String) {
        try {
            val uri = FileProvider.getUriForFile(this, "$packageName.fileprovider", file)
            val view = Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(uri, mime)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            startActivity(Intent.createChooser(view, getString(R.string.attachment_open_with)).apply {
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            })
        } catch (e: Exception) {
            // Nothing installed that can open this type (or the chooser itself
            // failed) — put a copy somewhere the user can reach it instead of
            // dead-ending, since the download itself already succeeded.
            saveToPublicDownloads(file, mime)
        }
    }

    /** Last-resort fallback: copy the already-downloaded file into the shared
     *  Downloads collection so the Files app can get at it. Goes through
     *  MediaStore (API 29+) — under scoped storage, writing to the public
     *  Downloads directory by path throws, and MediaStore needs no permission
     *  at all. Below 29 the direct path write is still the correct API, and
     *  WRITE_EXTERNAL_STORAGE isn't needed for the app's own Downloads entry. */
    private fun saveToPublicDownloads(file: File, mime: String) {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                val values = ContentValues().apply {
                    put(MediaStore.MediaColumns.DISPLAY_NAME, file.name)
                    put(MediaStore.MediaColumns.MIME_TYPE, mime)
                    put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS)
                }
                val uri = contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
                    ?: throw IllegalStateException("MediaStore refused the insert")
                contentResolver.openOutputStream(uri).use { out ->
                    file.inputStream().use { it.copyTo(out!!) }
                }
            } else {
                val dest = File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), file.name)
                file.copyTo(dest, overwrite = true)
            }
            Toast.makeText(this, getString(R.string.attachment_saved), Toast.LENGTH_LONG).show()
        } catch (e: Exception) {
            Toast.makeText(this, getString(R.string.attachment_no_app), Toast.LENGTH_LONG).show()
        }
    }

    // -------------------------------------------------------------------------
    // Native safe-area padding: pad the WebView itself for the status bar, the camera
    // cutout and the navigation bar, so the page needs no knowledge of any of it. The
    // alternative — injecting --sat/--sab/--sal/--sar CSS vars and letting the page pad
    // itself — is the legacy path above, selected by BuildConfig.NATIVE_SAFE_AREA_INSETS.
    // -------------------------------------------------------------------------

    private fun setupNativeSafeAreaPadding() {
        if (!BuildConfig.NATIVE_SAFE_AREA_INSETS) return
        // Reactive (not one-shot): recomputes on rotation, cutout changes, and whenever
        // setImmersiveMode() shows/hides the status bar, so padding always matches reality.
        // When system bars are hidden (immersive), statusBars' inset collapses to 0 and this
        // naturally reduces to just the physical camera-cutout inset, which is exactly right —
        // the cutout hardware doesn't go away just because the status bar isn't drawn.
        ViewCompat.setOnApplyWindowInsetsListener(webView) { view, insets ->
            val combined = WindowInsetsCompat.Type.statusBars() or WindowInsetsCompat.Type.displayCutout()
            val bars = insets.getInsets(combined)
            // Margin, not view.setPadding(): the inset values themselves are correct
            // (confirmed via temporary on-device diagnostics), but setPadding() was NOT
            // visually honored on-device — a known WebView quirk where its internal
            // Chromium compositor can paint its surface without respecting the
            // Android View's own padding, even though the View object itself reports
            // it correctly. A margin operates at the parent ViewGroup layout level
            // instead, physically shrinking the WebView's bounds so its rendering
            // surface never extends into the inset area in the first place — no
            // dependence on WebView's internal painting respecting anything.
            // The nav bar's own inset, so page content isn't drawn behind it. Only
            // matters when HIDE_NAV_BAR is false (nav bar permanently
            // visible instead of hidden/transient) — naturally 0 on every side when
            // the bar IS hidden, so this is safe to always include rather than
            // branching on that flag here too.
            //
            // ALL FOUR SIDES, not just .bottom, which is what this used to read. In
            // landscape a phone moves the 3-button bar to whichever edge is now the
            // device's "bottom", and on many devices that is the left or right side of
            // the window — so taking only .bottom drew the page underneath the buttons
            // in both landscape rotations, while portrait looked perfectly fine.
            val navBars = insets.getInsets(WindowInsetsCompat.Type.navigationBars())
            val navBottom = navBars.bottom
            // On-screen keyboard: android:windowSoftInputMode="adjustResize" (see the
            // manifest) stops actually resizing anything once decorFitsSystemWindows is
            // false (a documented edge-to-edge gap, not specific to this app) — we have
            // to shrink the WebView ourselves via the IME inset instead, same as the nav
            // bar/cutout above, or a focused field near the bottom of the page (e.g. the
            // login screen's password input) stays hidden behind the keyboard with
            // nothing to push it into view. maxOf, not added on top of navBottom: the
            // keyboard already fully covers the nav bar's own area while it's up.
            val imeBottom = insets.getInsets(WindowInsetsCompat.Type.ime()).bottom
            val lp = view.layoutParams as android.view.ViewGroup.MarginLayoutParams
            // maxOf per side: the cutout and the nav bar can be on the same
            // edge (landscape, cutout left and buttons left) and whichever
            // needs more room wins — adding them would push content twice as
            // far in as anything requires.
            lp.topMargin = maxOf(bars.top, navBars.top)
            lp.leftMargin = maxOf(bars.left, navBars.left)
            lp.rightMargin = maxOf(bars.right, navBars.right)
            lp.bottomMargin = maxOf(bars.bottom, navBottom, imeBottom)
            view.layoutParams = lp
            insets
        }
        ViewCompat.requestApplyInsets(webView)
    }

    // -------------------------------------------------------------------------
    // Notification API shim
    // -------------------------------------------------------------------------
    // Android's WebView does not implement the Web Notification/Push APIs at all —
    // window.Notification is simply undefined, in every Chrome/WebView version, on
    // every Android version. This is not a permission problem; the browser feature
    // just isn't there. So instead of relying on the wrapped page's own
    // Notification.requestPermission()/new Notification(...) calls (which will never
    // fire in a stock WebView), we define a small window.Notification polyfill that
    // routes those same calls through our native JS bridge. Any web app's existing
    // "ask for notification permission" / "show a notification" code keeps working
    // completely unmodified.
    //
    // Also injects window.CodexaPush, a small helper for *real* push (delivered via
    // Firebase Cloud Messaging instead of the standard Web Push/VAPID flow, since
    // WebView has no Service Worker Push event support at all). Use it like:
    //
    //   if (window.CodexaPush && CodexaPush.isSupported()) {
    //     CodexaPush.subscribe().then(function(token) {
    //       // send `token` to your backend, tagged as an FCM registration
    //       // (separate from your existing VAPID/webpush subscriptions for real browsers)
    //     });
    //   } else {
    //     // fall back to standard navigator.serviceWorker + PushManager (real browsers)
    //   }
    //
    // See TEMPLATE_README.md "Real push notifications (FCM)" for the full picture,
    // including what has to change on the Hmelj server to actually deliver to this token.
    private val notificationShimJs = """
        (function() {
            if (window.Notification) return;
            window.__codexaNotifPending = [];
            function Notification(title, options) {
                options = options || {};
                this.title = title;
                this.body = options.body || '';
                this.tag = options.tag || '';
                var id = Math.floor(Math.random() * 2147483647);
                if (window.AndroidApp && AndroidApp.showNotification) {
                    AndroidApp.showNotification(String(title), String(this.body), id);
                }
            }
            Notification.permission = (window.AndroidApp && AndroidApp.hasNotificationPermission &&
                AndroidApp.hasNotificationPermission()) ? 'granted' : 'default';
            Notification.requestPermission = function(cb) {
                return new Promise(function(resolve) {
                    if (window.AndroidApp && AndroidApp.requestNotificationPermission) {
                        window.__codexaNotifPending.push({ resolve: resolve, cb: cb });
                        AndroidApp.requestNotificationPermission();
                    } else {
                        Notification.permission = 'denied';
                        if (cb) cb('denied');
                        resolve('denied');
                    }
                });
            };
            Notification.prototype.close = function() {};
            window.Notification = Notification;
            // Called from native once the Android permission dialog/settings result is known.
            window.__codexaNotifPermissionResult = function(granted) {
                var perm = granted ? 'granted' : 'denied';
                Notification.permission = perm;
                while (window.__codexaNotifPending.length) {
                    var p = window.__codexaNotifPending.shift();
                    if (p.cb) p.cb(perm);
                    p.resolve(perm);
                }
            };
        })();
        (function() {
            if (window.CodexaPush) return;
            window.__codexaPushPending = [];
            window.CodexaPush = {
                isSupported: function() {
                    return !!(window.AndroidApp && AndroidApp.isPushSupported && AndroidApp.isPushSupported());
                },
                subscribe: function() {
                    return new Promise(function(resolve, reject) {
                        if (!(window.AndroidApp && AndroidApp.requestPushToken)) {
                            reject(new Error('CodexaPush not available in this build'));
                            return;
                        }
                        window.__codexaPushPending.push({ resolve: resolve, reject: reject });
                        AndroidApp.requestPushToken();
                    });
                }
            };
            // Called from native with the FCM token (or null on failure) — resolves every
            // pending subscribe() call, and any unsolicited token refresh (device re-registered).
            window.__codexaPushTokenResult = function(token) {
                var pending = window.__codexaPushPending;
                window.__codexaPushPending = [];
                pending.forEach(function(p) {
                    if (token) p.resolve(token); else p.reject(new Error('No push token available'));
                });
                if (token && typeof window.onCodexaPushToken === 'function') {
                    window.onCodexaPushToken(token); // optional hook for unsolicited refreshes
                }
            };
        })();
    """.trimIndent()

    private fun injectNotificationShim() {
        if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            // Guaranteed to run before the page's own scripts — no race with the page's
            // own `if ('Notification' in window)` feature check.
            WebViewCompat.addDocumentStartJavaScript(webView, notificationShimJs, setOf("*"))
            notificationShimNeedsFallbackInjection = false
        } else {
            // Fallback for WebView providers that don't support addDocumentStartJavaScript:
            // inject on every page load instead (see onPageStarted). Slightly racy — the
            // page's own scripts could in theory run first — but works for the common case
            // where feature-detection happens lazily (e.g. on a settings screen tap) rather
            // than at the very top of the page.
            notificationShimNeedsFallbackInjection = true
        }
    }

    // -------------------------------------------------------------------------
    // Immersive mode (hide system navigation bar in reader)
    // -------------------------------------------------------------------------

    private fun setImmersiveMode(enable: Boolean) {
        val controller = WindowInsetsControllerCompat(window, window.decorView)
        controller.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        if (BuildConfig.HIDE_NAV_BAR) {
            // Original combined behavior: IMMERSIVE_MODE governs status bar + nav bar together.
            if (enable) controller.hide(WindowInsetsCompat.Type.systemBars())
            else controller.show(WindowInsetsCompat.Type.systemBars())
        } else {
            // Bottom nav bar (3-button/gesture) always visible — hiding it made
            // everyday use awkward in practice. IMMERSIVE_MODE still governs the
            // status bar only.
            controller.show(WindowInsetsCompat.Type.navigationBars())
            if (enable) controller.hide(WindowInsetsCompat.Type.statusBars())
            else controller.show(WindowInsetsCompat.Type.statusBars())
        }
        // Toggling system bars changes the actual safe-area inset values the page/
        // WebView sees — without this, a page that reads its own insets (via
        // window.__applyInsets(), see index.html) could hold a stale value from
        // before this toggle until its own next unrelated re-check. Harmless no-op
        // if the loaded page never defined that hook — which is the normal case with
        // NATIVE_SAFE_AREA_INSETS on, where padding comes from
        // setupNativeSafeAreaPadding()'s own reactive WindowInsets listener instead —
        // and for any page mid-navigation.
        if (::webView.isInitialized) {
            webView.evaluateJavascript("if(typeof window.__applyInsets==='function') window.__applyInsets();", null)
        }
    }

    // -------------------------------------------------------------------------
    // Notification channel (required once, up front, on Android 8+)
    // -------------------------------------------------------------------------

    // Both channels are defined in MailNotifications so the FCM service — which runs
    // with no Activity at all on a cold push-start — creates exactly the same ones.
    private fun createNotificationChannel() = MailNotifications.createChannels(this)

    // -------------------------------------------------------------------------
    // Server URL management
    // -------------------------------------------------------------------------

    private fun openServerSelect(cancellable: Boolean) {
        val intent = Intent(this, ServerSelectActivity::class.java).apply {
            putExtra(ServerSelectActivity.EXTRA_INITIAL_URL, getSavedUrl() ?: "")
            putExtra("cancellable", cancellable)
        }
        serverSelectLauncher.launch(intent)
    }

    private fun getSavedUrl(): String? =
        getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .getString(PREF_URL, null)

    private fun saveUrl(url: String) =
        getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .edit()
            .putString(PREF_URL, url)
            .apply()

    /** Forwards a fresh FCM token (or null on failure) to the currently-open page, if any. */
    private fun deliverPushTokenToJs(token: String?) {
        runOnUiThread {
            val jsArg = if (token != null) jsStringLiteral(token) else "null"
            webView.evaluateJavascript(
                "if(typeof window.__codexaPushTokenResult==='function') window.__codexaPushTokenResult($jsArg);",
                null
            )
        }
    }

    private fun jsStringLiteral(s: String): String =
        "\"" + s.replace("\\", "\\\\").replace("\"", "\\\"") + "\""

    /**
     * Delivers the routing payload from a tapped push notification (the sender's
     * `data: {accountId, folder, uid}` object, as raw JSON) to window.onCodexaPushTapped(),
     * if the page has defined that hook — lets Hmelj's frontend jump straight to the
     * tapped email/thread instead of just opening to whatever was last on screen.
     */
    private fun deliverPushTapToJs(dataJson: String) {
        runOnUiThread {
            webView.evaluateJavascript(
                "if(typeof window.onCodexaPushTapped==='function') window.onCodexaPushTapped($dataJson);",
                null
            )
        }
    }

    companion object {
        private const val PREFS_NAME = "codexa_prefs"
        private const val PREF_URL   = "server_url"
        /** Channel ids, the badge notification id and the shared group key now live in
         *  MailNotifications — the FCM service needs the same values and can't reach
         *  into an Activity for them. Kept here as aliases so existing call sites in
         *  this file read unchanged. */
        const val NOTIFICATION_CHANNEL_ID = MailNotifications.CHANNEL_MAIL
        private const val NEW_MAIL_GROUP = MailNotifications.GROUP

        /** Intent extra key HmeljFirebaseMessagingService uses to pass a tapped push
         *  notification's routing data through to deliverPushTapToJs(). */
        const val EXTRA_PUSH_DATA = "codexa_push_data"

        /** The currently resumed MainActivity, if any — used to forward a fresh FCM token
         *  straight into the open page without waiting for the next explicit request. */
        @Volatile
        private var activeInstance: MainActivity? = null

        /** Called by HmeljFirebaseMessagingService.onNewToken(). Safe no-op if nothing is open. */
        fun notifyPushTokenRefreshed(token: String) {
            activeInstance?.deliverPushTokenToJs(token)
        }
    }
}
