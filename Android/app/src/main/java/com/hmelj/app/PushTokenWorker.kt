package com.hmelj.app

import android.content.Context
import android.net.Uri
import android.webkit.CookieManager
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.Data
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.TimeUnit

/**
 * Registers this device's FCM token with the Hmelj server from NATIVE code,
 * without needing the WebView to be alive.
 *
 * Why this exists: a push registration is only as good as the server's copy of
 * the token, and FCM rotates tokens on its own (reinstall, app-data clear,
 * periodic refresh). Previously the only way a token ever reached the server
 * was the page calling AndroidApp.requestPushToken() and POSTing the result —
 * so a rotation while the app was closed was lost, the server pruned the stale
 * token as dead, and the device went permanently silent. WorkManager keeps
 * retrying across process death and reboots until it lands.
 *
 * Auth: the session cookie the WebView already holds for the server origin,
 * read from the shared CookieManager. No separate credential, no token of our
 * own — the exact same cookie the page's own fetch() would have sent. If the
 * session has expired there's nothing valid to send, so the work fails and is
 * retried; the page-side ensurePushRegistered() also covers that case the next
 * time the user opens the app.
 */
class PushTokenWorker(context: Context, params: WorkerParameters) : Worker(context, params) {

    override fun doWork(): Result {
        val prefs = applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val baseUrl = prefs.getString(PREF_URL, null) ?: return Result.success() // no server configured yet — nothing to register with
        val badgeOnly = inputData.getBoolean(KEY_BADGE_ONLY, false)
        val token = inputData.getString(KEY_TOKEN) ?: prefs.getString(PREF_TOKEN, null)

        val origin = try {
            val u = Uri.parse(baseUrl)
            "${u.scheme}://${u.authority}"
        } catch (e: Exception) {
            return Result.success() // malformed saved URL — retrying won't fix it
        }

        // Not signed in yet (or cookies not flushed). Worth a few retries in
        // case this is a transient startup ordering thing, but not forever:
        // MainActivity.onResume re-enqueues on every foreground, so the real
        // recovery path for "user finally signs in" is that, not this backoff
        // chain grinding away for hours.
        val cookie = CookieManager.getInstance().getCookie(origin)
        if (cookie.isNullOrEmpty()) return retryOrGiveUp()

        return if (badgeOnly) refreshBadge(origin, cookie) else uploadToken(origin, cookie, token)
    }

    private fun uploadToken(origin: String, cookie: String, token: String?): Result {
        if (token.isNullOrEmpty()) return Result.success()
        val body = JSONObject()
            .put("subscription", JSONObject().put("type", "fcm").put("token", token))
            .put("ua", "Android; ${android.os.Build.MODEL}; HmeljApp/${BuildConfig.VERSION_NAME}")
            .toString()
        return when (post("$origin/api/push/subscribe", cookie, body)) {
            in 200..299 -> Result.success()
            401, 403 -> retryOrGiveUp()     // session expired — the user will sign in again
            in 400..499 -> Result.failure() // malformed; retrying can't help
            else -> retryOrGiveUp()         // server/network trouble
        }
    }

    /** Pull the authoritative unread total and apply it to the launcher badge. */
    private fun refreshBadge(origin: String, cookie: String): Result {
        return try {
            val conn = (URL("$origin/api/unread").openConnection() as HttpURLConnection).apply {
                requestMethod = "GET"
                setRequestProperty("Cookie", cookie)
                connectTimeout = 15000
                readTimeout = 15000
            }
            val code = conn.responseCode
            if (code !in 200..299) { conn.disconnect(); return if (code in 400..499) Result.failure() else retryOrGiveUp() }
            val text = conn.inputStream.bufferedReader().use { it.readText() }
            conn.disconnect()
            MailNotifications.setBadge(applicationContext, JSONObject(text).optInt("total", 0))
            Result.success()
        } catch (e: Exception) {
            retryOrGiveUp()
        }
    }

    /** Retry until MAX_ATTEMPTS, then stop rather than backing off forever.
     *  Reported as success, not failure: nothing is broken, we just gave up on
     *  this particular attempt — MainActivity.onResume enqueues a fresh one on
     *  every foreground, which is the real recovery path. */
    private fun retryOrGiveUp(): Result =
        if (runAttemptCount < MAX_ATTEMPTS) Result.retry() else Result.success()

    private fun post(url: String, cookie: String, body: String): Int {
        return try {
            val conn = (URL(url).openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                doOutput = true
                setRequestProperty("Content-Type", "application/json")
                setRequestProperty("Cookie", cookie)
                connectTimeout = 15000
                readTimeout = 15000
            }
            conn.outputStream.use { it.write(body.toByteArray()) }
            val code = conn.responseCode
            conn.disconnect()
            code
        } catch (e: Exception) {
            -1 // network failure -> caller retries
        }
    }

    companion object {
        private const val PREFS_NAME = "codexa_prefs"
        private const val PREF_URL = "server_url"
        private const val PREF_TOKEN = "fcm_token"
        private const val KEY_TOKEN = "token"
        private const val KEY_BADGE_ONLY = "badgeOnly"
        private const val WORK_TOKEN = "codexa-push-token"
        private const val WORK_BADGE = "codexa-badge-refresh"
        /** ~30s, 90s, 4.5m, 13m, 40m with exponential backoff — well past any
         *  plausible transient, and MainActivity.onResume re-enqueues anyway. */
        private const val MAX_ATTEMPTS = 5

        private fun constraints() = Constraints.Builder()
            .setRequiredNetworkType(NetworkType.CONNECTED)
            .build()

        /** Register (or re-register) `token` with the server, retrying until it sticks. */
        fun enqueue(context: Context, token: String) {
            val req = OneTimeWorkRequestBuilder<PushTokenWorker>()
                .setInputData(Data.Builder().putString(KEY_TOKEN, token).build())
                .setConstraints(constraints())
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
                .build()
            // REPLACE: only the newest token is worth sending.
            WorkManager.getInstance(context).enqueueUniqueWork(WORK_TOKEN, ExistingWorkPolicy.REPLACE, req)
        }

        /** Re-read the unread total and fix the badge (see onDeletedMessages). */
        fun enqueueBadgeRefresh(context: Context) {
            val req = OneTimeWorkRequestBuilder<PushTokenWorker>()
                .setInputData(Data.Builder().putBoolean(KEY_BADGE_ONLY, true).build())
                .setConstraints(constraints())
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
                .build()
            WorkManager.getInstance(context).enqueueUniqueWork(WORK_BADGE, ExistingWorkPolicy.REPLACE, req)
        }
    }
}
