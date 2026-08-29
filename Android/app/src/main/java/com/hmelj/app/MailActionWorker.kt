package com.hmelj.app

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.webkit.CookieManager
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.Data
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.TimeUnit

/**
 * Applies one notification-tray action ("Mark as read" / "Delete") to one
 * message, by calling the same REST endpoints the web app itself uses.
 *
 * Runs in a worker rather than in NotificationActionReceiver directly because
 * the action must not be lost when the phone happens to be offline or the
 * process is killed a moment later: WorkManager holds the job across both and
 * retries it. The user tapped a button; "the tap did nothing and nothing said
 * so" is the one outcome worth engineering against.
 *
 * Auth is the WebView's own session cookie for the server origin — same
 * approach, and same reasoning, as PushTokenWorker (see its header). The two
 * share the cookie/origin dance but little else, so this keeps its own small
 * HTTP helper rather than growing a shared layer for ~20 lines.
 */
class MailActionWorker(context: Context, params: WorkerParameters) : Worker(context, params) {

    override fun doWork(): Result {
        val action = inputData.getString(KEY_ACTION) ?: return Result.success()
        val folder = inputData.getString(KEY_FOLDER) ?: return Result.success()
        val uid = inputData.getString(KEY_UID) ?: return Result.success()
        val accountId = inputData.getString(KEY_ACCOUNT)?.takeIf { it.isNotEmpty() }

        val prefs = applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val baseUrl = prefs.getString(PREF_URL, null) ?: return Result.success() // no server configured — nothing this could act on
        val origin = try {
            val u = Uri.parse(baseUrl)
            "${u.scheme}://${u.authority}"
        } catch (e: Exception) {
            return Result.success() // malformed saved URL — retrying won't fix it
        }

        // Signed out (or cookies not yet flushed to disk). Worth retrying: the
        // session usually comes back, and until then there is nothing to send.
        val cookie = CookieManager.getInstance().getCookie(origin)
        if (cookie.isNullOrEmpty()) return retryOrReport(action, accountId, folder, uid)

        val endpoint = if (action == NotificationActionReceiver.ACTION_READ) "flags" else "delete"
        val url = "$origin/api/messages/${Uri.encode(folder)}/$endpoint" +
            (accountId?.let { "?account=" + Uri.encode(it) } ?: "")

        // Same request bodies public/js/api.js's flags()/deleteMsgs() send. The
        // uid goes over as a NUMBER when it looks like one, because that's what
        // the server's IMAP layer expects — a quoted "1234" is not the same thing.
        // Typed Any so the JSONArray.put overload is unambiguous either way.
        val uidValue: Any = uid.toLongOrNull() ?: uid
        val body = JSONObject().apply {
            put("uids", JSONArray().put(uidValue))
            if (action == NotificationActionReceiver.ACTION_READ) {
                put("add", JSONArray().put("\\Seen"))
                put("remove", JSONArray())
            }
        }.toString()

        return when (post(url, cookie, body)) {
            in 200..299 -> {
                // The tray action just changed this user's unread total, and with
                // no window open nothing else would correct the launcher badge —
                // it would sit one too high until the app was next opened. Same
                // fix public/sw.js applies with refreshBadgeFromServer().
                PushTokenWorker.enqueueBadgeRefresh(applicationContext)
                Result.success()
            }
            // 401/403 (session expired) and any other 4xx are answers, not
            // outages: the server understood and refused, so retrying the same
            // request later changes nothing.
            in 400..499 -> { reportFailure(action, accountId, folder, uid); Result.failure() }
            else -> retryOrReport(action, accountId, folder, uid) // 5xx or no network
        }
    }

    /** Keep retrying while it's plausibly transient; once we give up, SAY so —
     *  the notification was already dismissed when the button was tapped, so a
     *  silent give-up would leave the user believing the mail was read/deleted
     *  when it wasn't. */
    private fun retryOrReport(action: String, accountId: String?, folder: String, uid: String): Result {
        if (runAttemptCount < MAX_ATTEMPTS) return Result.retry()
        reportFailure(action, accountId, folder, uid)
        return Result.success() // reported; nothing left to retry
    }

    /**
     * Put a notification back in the tray saying the action didn't happen.
     * Tapping it opens the message, so the obvious next step is one tap away —
     * routed exactly like a tapped new-mail notification
     * (MainActivity.EXTRA_PUSH_DATA).
     */
    private fun reportFailure(action: String, accountId: String?, folder: String, uid: String) {
        val nm = NotificationManagerCompat.from(applicationContext)
        if (!nm.areNotificationsEnabled()) return
        MailNotifications.createChannels(applicationContext)

        val routeData = JSONObject().apply {
            if (!accountId.isNullOrEmpty()) put("accountId", accountId)
            put("folder", folder)
            put("uid", (uid.toLongOrNull() ?: uid) as Any)
        }.toString()
        val tapIntent = Intent(applicationContext, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
            putExtra(MainActivity.EXTRA_PUSH_DATA, routeData)
        }
        val id = "fail/$folder/$uid/$action".hashCode()
        val text = applicationContext.getString(
            if (action == NotificationActionReceiver.ACTION_READ) R.string.notification_action_read_failed
            else R.string.notification_action_delete_failed
        )
        val notification = NotificationCompat.Builder(applicationContext, MailNotifications.CHANNEL_MAIL)
            .setSmallIcon(R.drawable.ic_launcher_foreground)
            .setContentTitle(applicationContext.getString(R.string.app_name))
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setAutoCancel(true)
            .setContentIntent(
                PendingIntent.getActivity(
                    applicationContext, id, tapIntent,
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
                )
            )
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .setGroup(MailNotifications.GROUP)
            .build()
        try {
            nm.notify(id, notification)
        } catch (e: SecurityException) {
            // POST_NOTIFICATIONS revoked between the check above and here.
        }
    }

    private fun post(url: String, cookie: String, body: String): Int {
        return try {
            val conn = (URL(url).openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                doOutput = true
                setRequestProperty("Content-Type", "application/json")
                setRequestProperty("Cookie", cookie)
                connectTimeout = 15000
                readTimeout = 20000
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
        private const val KEY_ACTION = "action"
        private const val KEY_ACCOUNT = "accountId"
        private const val KEY_FOLDER = "folder"
        private const val KEY_UID = "uid"
        /** ~10s, 30s, 90s, 4.5m with exponential backoff — an action the user
         *  took by hand deserves more patience than a background refresh, but
         *  not so much that "it failed" arrives an hour later. */
        private const val MAX_ATTEMPTS = 4

        /**
         * NOT unique work: two notifications acted on in the same moment are two
         * independent jobs, and REPLACE would silently drop one of them.
         */
        fun enqueue(context: Context, action: String, accountId: String?, folder: String, uid: String, notificationId: Int) {
            val data = Data.Builder()
                .putString(KEY_ACTION, action)
                .putString(KEY_ACCOUNT, accountId ?: "") // Data has no null values; "" is read back as "no account"
                .putString(KEY_FOLDER, folder)
                .putString(KEY_UID, uid)
                .build()
            val req = OneTimeWorkRequestBuilder<MailActionWorker>()
                .setInputData(data)
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 10, TimeUnit.SECONDS)
                .addTag("codexa-mail-action-$notificationId")
                .build()
            WorkManager.getInstance(context).enqueue(req)
        }
    }
}
