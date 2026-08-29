# Hmelj for Android

A thin native shell around the Hmelj web app: a full-screen WebView pointed at *your*
Hmelj server, plus the handful of things a browser cannot do — real push notifications
while the app is closed, notification action buttons, a launcher unread badge, OAuth
sign-in in a real browser tab, and attachment hand-off to other apps.

It is a **client**. It contains no mail code. On first launch it asks for a server URL,
remembers it, and lets you change it later (press back twice on the main screen, or from
the app's own menu).

> Nothing here needs to be built to use Hmelj. The web app installs as a PWA on Android
> too; the APK exists because a PWA on Android cannot receive push while it is closed.

---

## Layout

```
app/build.gradle                     application id, versions, signing, BuildConfig flags
app/src/main/java/com/hmelj/app/
    MainActivity.kt                  the WebView, the JS bridge, safe-area/immersive handling
    ServerSelectActivity.kt          the "enter your server URL" screen
    MailNotifications.kt             notification channels and the unread badge
    HmeljFirebaseMessagingService.kt receives FCM pushes (even from a cold process)
    HmeljApplication.kt              creates the channels before anything else can post
    NotificationActionReceiver.kt    "Mark as read" / "Delete" buttons on a notification
    MailActionWorker.kt              performs those actions against the server, with retry
    PushTokenWorker.kt               uploads a rotated FCM token, surviving process death
app/src/main/res/                    icons, colours, layouts, strings (en, sl, de, es, fr, it, pt)
```

There is exactly one build variant pair — `debug` and `release`. This project used to be
a white-label template with product flavors; it isn't any more, and the CI workflows
depend on that (`assembleRelease` writing to `app/build/outputs/apk/release/`, with no
flavor segment in the path).

## Building

Requirements: **JDK 17**, Android SDK with **API 35**, and either Android Studio or the
Gradle wrapper. `local.properties` (SDK path) is git-ignored and Android Studio writes it
for you.

```bash
./gradlew assembleDebug      # app/build/outputs/apk/debug/com.hmelj.app.debug-1.0.0-debug.apk
./gradlew assembleRelease    # app/build/outputs/apk/release/com.hmelj.app-1.0.0.apk
./gradlew bundleRelease      # app/build/outputs/bundle/release/app-release.aab  (Google Play)
```

On Windows use `gradlew.bat`, or Build → Generate Signed App Bundle / APK in Android
Studio.

### Signing

`signingConfigs.release` in `app/build.gradle` picks the first of these that is present,
in this order:

| # | Source | Used by |
|---|---|---|
| 1 | `KEYSTORE_FILE` + `KEYSTORE_PASSWORD` + `KEY_ALIAS` + `KEY_PASSWORD` env vars | CI, for the **Google Play** AAB only |
| 2 | `DEV_KEYSTORE_FILE` + `DEV_KEYSTORE_PASSWORD` + `DEV_KEY_ALIAS` + `DEV_KEY_PASSWORD` env vars | CI, for the **sideload/GitHub Release** APK |
| 3 | `keystore.properties` next to this file | your local Android Studio builds |
| — | nothing | release build is left **unsigned** and cannot be installed |

The two CI keystores are deliberately separate and the release APK deliberately never
looks at `KEYSTORE_FILE`. Android only allows an in-place update when the new APK carries
the *same* signing certificate as the installed one, so if the sideload APK ever switched
to the Play upload key, every existing sideloaded install would stop being updatable.

For a local build that produces an APK people can install **over** a CI-built one, create
`Android/keystore.properties` (git-ignored) holding the same key CI uses:

```properties
storeFile=keystore/dev-release.jks
storePassword=…
keyAlias=…
keyPassword=…
```

`storeFile` is resolved relative to this `Android/` directory. How to create that keystore
and put it into GitHub Actions is in the documentation site under **Building the Android
app**.

### Push (Firebase)

`app/google-services.json` is **git-ignored** — it identifies one specific Firebase
project, and a fork building this repo has no business sending its device tokens there.

- Without it the project builds and runs normally. `BuildConfig.PUSH_ENABLED` is `false`,
  `window.CodexaPush.isSupported()` returns `false`, and the web app falls back to saying
  push isn't available on this device. Web Push for real browsers and installed PWAs is a
  completely separate mechanism and is unaffected.
- With it, `HmeljFirebaseMessagingService` receives pushes even from a cold process.
- CI writes the file from the `GOOGLE_SERVICES_JSON` repository secret.

See `app/google-services.json.example.txt` for the shape, and the documentation site
(**Android push (Firebase)**) for the console walkthrough — both the app registration and
the server-side service-account key.

The Gradle plugin **fails the build** for an `applicationId` that has no client in
`google-services.json`, which is why `app/build.gradle` reads the file itself and only
applies `applicationIdSuffix ".debug"` when a `com.hmelj.app.debug` client actually
exists. Register that second client if you want side-by-side debug and release installs.

## The JS bridge

Injected into every page the WebView loads, as `window.AndroidApp` (and `AndroidCodexa`,
a back-compat alias — see below).

| Method | Does |
|---|---|
| `getAppVersion()` | returns `versionName` |
| `changeServer()` | reopens the "enter your server URL" screen |
| `setPortraitLock(lock)` | locks / unlocks orientation |
| `setKeepScreenOn(on)` | stops the screen dimming while Hmelj is open |
| `isNightMode()` | Android's system dark-mode state |
| `setStatusBarAppearance(light)` | flips status/nav-bar icon colour to match the web theme |
| `hasNotificationPermission()` / `requestNotificationPermission()` | Android 13+ consent |
| `showNotification(title, body, id)` | posts a local notification |
| `isIgnoringBatteryOptimizations()` / `requestIgnoreBatteryOptimizations()` | Doze exemption prompt |
| `setUnreadBadgeCount(n)` | launcher badge, via a silent summary notification |
| `openExternal(url)` | opens a URL in a Chrome Custom Tab — how OAuth sign-in escapes the WebView |
| `openLink(url)` | opens an ordinary outbound link in the user's browser |
| `openAttachment(url, filename, mime)` | downloads with the session cookie and offers it to another app |
| `isPushSupported()` / `requestPushToken()` | the native half of `window.CodexaPush` below |
| `isEinkMode()` / `setEinkMode(on)` | persisted grayscale mode for e-ink devices |
| `setVolumeKeyMode(on)`, `setReaderMode(on)`, `setBackgroundColor(css)`, `getServerUrl()`, `retryConnection()` | inherited from the WebView shell; see `MainActivity.kt` |

Android's WebView implements **no** Web Notification or Push API, on any version — so the
shell also injects a `window.Notification` polyfill that routes through
`requestNotificationPermission()` / `showNotification()`, and a `window.CodexaPush` helper
for real server-initiated push:

```js
if (window.CodexaPush && CodexaPush.isSupported()) {
  CodexaPush.subscribe().then((token) => { /* POST it to the server as an FCM token */ });
} else {
  // real browser — navigator.serviceWorker + PushManager + VAPID
}
```

### Names that look wrong and are not

`AndroidCodexa`, `window.CodexaPush`, the `window.__codexa*` hooks, the `codexa_prefs`
SharedPreferences file and the `codexa_mail_v2` / `codexa_unread_badge` notification
channel ids are all inherited from the WebView shell this app was built from, and they
**stay**:

- The JS names are a wire contract with the web app (`public/js/app.js`, `oauth.js`,
  `messageFrame.js`, `attachmentViewer.js`). The two halves update independently — a
  phone running last month's APK talks to a server deployed today — so renaming either
  side alone breaks push and OAuth sign-in for everyone in between.
- The preferences file and the channel ids are persistence keys. Renaming them makes an
  updated app forget the configured server URL, or silently discard the user's chosen
  notification sound and importance.

None of it is visible anywhere in the UI.

## Push payload contract

`HmeljFirebaseMessagingService` expects a **data-only** FCM message (no top-level
`notification` block, so the app controls how it is displayed) carrying the whole
notification as one JSON string under `data.payload`:

```json
{
  "title": "New mail from …",
  "body": "Subject line or preview text",
  "tag": "acct123-INBOX-456",
  "data": { "accountId": "acct123", "folder": "INBOX", "uid": "456" }
}
```

- `tag` — a stable notification id, so a follow-up push for the same message replaces it
  instead of stacking a duplicate.
- `data` — opaque routing info, delivered to the page as
  `window.onCodexaPushTapped(data)` once it has loaded, so a tap opens that message.

The server side of this is `server/push.js`.
