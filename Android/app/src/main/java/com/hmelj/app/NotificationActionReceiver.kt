package com.hmelj.app

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationManagerCompat

/**
 * The "Mark as read" / "Delete" buttons on a new-mail notification.
 *
 * Tapping one must NOT open the app — the whole point is to clear a message
 * from the tray without leaving whatever you were doing — so the buttons fire
 * a broadcast here instead of an Activity intent. The browser/PWA side does
 * exactly the same thing from public/sw.js's notificationclick listener; this
 * is that behaviour for the native shell, which has no Service Worker at all
 * (see HmeljFirebaseMessagingService).
 *
 * A receiver gets ~10 seconds and is killed the moment onReceive returns, so
 * the actual API call is NOT made here: it's handed to MailActionWorker, which
 * survives process death, waits for a network, and retries. This receiver only
 * does the one thing that has to be instant — taking the notification out of
 * the tray, so the tap visibly did something.
 */
class NotificationActionReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        val action = intent.getStringExtra(EXTRA_ACTION) ?: return
        val folder = intent.getStringExtra(EXTRA_FOLDER) ?: return
        val uid = intent.getStringExtra(EXTRA_UID) ?: return
        val accountId = intent.getStringExtra(EXTRA_ACCOUNT)
        val notificationId = intent.getIntExtra(EXTRA_NOTIFICATION_ID, 0)

        if (notificationId != 0) NotificationManagerCompat.from(context).cancel(notificationId)

        MailActionWorker.enqueue(context.applicationContext, action, accountId, folder, uid, notificationId)
    }

    companion object {
        /** Must match the `action` ids the server puts in the push payload, and the
         *  ones public/sw.js checks for — one vocabulary across all three. */
        const val ACTION_READ = "read"
        const val ACTION_DELETE = "delete"

        const val EXTRA_ACTION = "codexa_mail_action"
        const val EXTRA_ACCOUNT = "codexa_mail_account"
        const val EXTRA_FOLDER = "codexa_mail_folder"
        const val EXTRA_UID = "codexa_mail_uid"
        const val EXTRA_NOTIFICATION_ID = "codexa_mail_notification_id"

        /**
         * A PendingIntent for one button on one notification.
         *
         * The request code has to be unique per (notification, action): two
         * PendingIntents that match on everything Intent#filterEquals compares
         * (component + action + data + type + categories — extras are NOT part of
         * it) are the SAME PendingIntent, so with a shared request code the second
         * mail's Delete button would carry the first mail's uid. Hence the
         * per-pair hash below.
         */
        fun pendingIntent(
            context: Context,
            action: String,
            notificationId: Int,
            accountId: String?,
            folder: String,
            uid: String,
        ): PendingIntent {
            val intent = Intent(context, NotificationActionReceiver::class.java).apply {
                putExtra(EXTRA_ACTION, action)
                putExtra(EXTRA_ACCOUNT, accountId)
                putExtra(EXTRA_FOLDER, folder)
                putExtra(EXTRA_UID, uid)
                putExtra(EXTRA_NOTIFICATION_ID, notificationId)
            }
            return PendingIntent.getBroadcast(
                context,
                "$notificationId/$action".hashCode(),
                intent,
                // FLAG_IMMUTABLE is required from API 31 and available since 23
                // (this app's minSdk is 26) — nothing is filling anything in here.
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
        }
    }
}
