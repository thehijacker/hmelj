package com.hmelj.app

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat

/**
 * Notification channels and the launcher-icon unread badge, in ONE place so
 * both entry points can use them.
 *
 * That's the whole point of this file. All of this used to live inside
 * MainActivity — which meant it only existed while an Activity was alive:
 *
 *  - The badge could only ever be set from the WebView (JsBridge
 *    .setUnreadBadgeCount, called by app.js). onPause() freezes the page's JS
 *    and onDestroy() tears the WebView down, so with the app backgrounded or
 *    closed nothing could update the count at all. A push arriving to a killed
 *    app left the badge at whatever the last foreground session wrote, which
 *    is exactly the "the number over the icon is wrong" symptom.
 *  - The badge CHANNEL was created only in MainActivity.onCreate. On a cold
 *    start caused by a push, MainActivity never runs — so on API 26+ any
 *    badge notification posted from the FCM service would have been silently
 *    dropped for want of a channel.
 */
object MailNotifications {

    // The `codexa_` prefix on the ids below is a leftover from the WebView shell
    // this app grew out of, and it stays. A channel id is a PERSISTENCE KEY:
    // Android remembers the user's chosen sound, importance and vibration under
    // it, and creating a channel under a new id silently discards all of that and
    // starts over at the default. Same for the group key. None of it is visible
    // anywhere in the UI — only the channel NAME is, and that comes from a
    // string resource.

    /**
     * Real new-mail notifications.
     *
     * Suffixed `_v2` because this channel is created at IMPORTANCE_HIGH and
     * the original `codexa_default` was IMPORTANCE_DEFAULT. A channel's
     * importance is fixed at creation — re-creating an existing channel with a
     * higher importance does nothing, by design (only the user may raise it) —
     * so an already-installed app would otherwise keep the old behaviour
     * forever. IMPORTANCE_DEFAULT produces no heads-up popup: the notification
     * lands silently in the tray, which users reasonably read as "the push
     * never arrived". Messaging apps use HIGH.
     */
    const val CHANNEL_MAIL = "codexa_mail_v2"

    /** Silent, minimum-importance channel carrying only the unread count. */
    const val CHANNEL_BADGE = "codexa_unread_badge"

    /** One fixed id, so repeated updates replace rather than stack. */
    const val BADGE_NOTIFICATION_ID = -1000

    /**
     * Shared group key for real new-mail notifications and the badge summary.
     * Without it, several launchers (Samsung One UI included) sum setNumber()
     * across every active notification independently, so a mail notification
     * sitting undismissed in the tray inflates the badge past the real total.
     */
    const val GROUP = "codexa_new_mail_group"

    /** Idempotent; safe to call from both Application.onCreate and an Activity. */
    fun createChannels(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

        val mail = NotificationChannel(
            CHANNEL_MAIL,
            context.getString(R.string.app_name),
            NotificationManager.IMPORTANCE_HIGH
        ).apply {
            setShowBadge(true)
            enableVibration(true)
        }
        manager.createNotificationChannel(mail)

        val badge = NotificationChannel(
            CHANNEL_BADGE,
            context.getString(R.string.unread_badge_channel_name),
            NotificationManager.IMPORTANCE_MIN
        ).apply {
            // Explicit: some OEM skins skip badging for MIN-importance
            // channels unless this is set, which defeats the entire purpose
            // of this channel.
            setShowBadge(true)
            setSound(null, null)
            enableVibration(false)
        }
        manager.createNotificationChannel(badge)
    }

    /**
     * Set the launcher-icon unread badge to `count` (cancelling it entirely at
     * zero rather than leaving a "0" behind).
     *
     * Implemented as a silent, minimum-priority group-summary notification
     * whose setNumber() carries the count, because Android has no direct
     * "set the launcher badge to N" API: the badge is normally derived from
     * how many notifications the app currently has posted, which can never go
     * DOWN when mail is read on a different device — no notification was ever
     * posted here to dismiss. A summary whose number we control tracks the
     * real total regardless of why it changed.
     *
     * Note that whether the NUMBER is rendered at all is up to the launcher:
     * Samsung One UI shows it, Pixel/stock Launcher3 shows only a dot. The
     * count is therefore also put in the notification's own text, so it's
     * always readable somewhere.
     */
    fun setBadge(context: Context, count: Int) {
        val nm = NotificationManagerCompat.from(context)
        if (count <= 0) {
            nm.cancel(BADGE_NOTIFICATION_ID)
            return
        }
        if (!nm.areNotificationsEnabled()) return
        createChannels(context)
        val notification = NotificationCompat.Builder(context, CHANNEL_BADGE)
            .setSmallIcon(R.drawable.ic_launcher_foreground)
            .setContentTitle(context.getString(R.string.app_name))
            .setContentText(context.getString(R.string.unread_badge_text, count))
            .setNumber(count)
            .setSilent(true)
            .setOnlyAlertOnce(true)
            .setAutoCancel(false)
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .setGroup(GROUP)
            .setGroupSummary(true)
            .build()
        try {
            nm.notify(BADGE_NOTIFICATION_ID, notification)
        } catch (e: SecurityException) {
            // POST_NOTIFICATIONS revoked between the check above and here.
        }
    }
}
