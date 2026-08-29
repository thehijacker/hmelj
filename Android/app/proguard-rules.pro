# Keep JS interface methods so they are not stripped by R8/ProGuard
-keepclassmembers class com.hmelj.app.MainActivity$JsBridge {
    @android.webkit.JavascriptInterface <methods>;
}

# WorkManager instantiates Workers reflectively by class name, so the class and
# its (Context, WorkerParameters) constructor must survive R8. The WorkManager
# artifact ships consumer rules covering this, but PushTokenWorker is the one
# thing standing between a rotated FCM token and the server — being explicit
# costs nothing and makes a release-only breakage impossible.
-keep class com.hmelj.app.PushTokenWorker { *; }

# Same reasoning for MailActionWorker, which backs the "Mark as read" / "Delete"
# buttons on a notification.
-keep class com.hmelj.app.MailActionWorker { *; }
