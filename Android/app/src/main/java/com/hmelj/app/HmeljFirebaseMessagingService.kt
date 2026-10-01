package com.hmelj.app

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

/**
 * Receives real push notifications via Firebase Cloud Messaging — including while this
 * app's process was previously fully killed (that's the whole point: Android WebView
 * cannot do this itself, see TEMPLATE_README.md "Real push notifications (FCM)").
 *
 * No-ops entirely unless app/google-services.json is present for this build (see that
 * file's accompanying .example.txt) — without it, FCM never registers this device, so
 * these callbacks simply never fire; nothing here needs its own BuildConfig.PUSH_ENABLED
 * guard for that reason.
 */
class HmeljFirebaseMessagingService : FirebaseMessagingService() {

    override fun onNewToken(token: String) {
        super.onNewToken(token)
        getSharedPreferences("codexa_prefs", Context.MODE_PRIVATE)
            .edit().putString("fcm_token", token).apply()

        // Upload it ourselves, with retries, from a background worker.
        //
        // THIS is the fix for "push worked for a while and then stopped
        // forever". FCM rotates a device's token on its own (reinstall,
        // app-data clear, periodic refresh). The only path this token had to
        // the server was notifyPushTokenRefreshed() below — which reaches a
        // MainActivity that is only non-null between onResume and onPause. A
        // rotation while the app was closed (i.e. almost always) was simply
        // dropped. The server then kept pushing to the old token, FCM answered
        // "registration-token-not-registered", the server pruned it as dead,
        // and this device never received another notification — with the
        // Settings checkbox still showing notifications as on.
        PushTokenWorker.enqueue(applicationContext, token)

        // Best-effort, additionally: if a page is open right now, let it know
        // immediately (see MainActivity.deliverPushTokenToJs).
        MainActivity.notifyPushTokenRefreshed(token)
    }

    /**
     * FCM dropped messages for this device (too many queued while offline, or they
     * outlived their TTL). We don't know what was missed, so re-sync the one piece of
     * state that must not be left wrong: the unread badge.
     */
    override fun onDeletedMessages() {
        super.onDeletedMessages()
        PushTokenWorker.enqueueBadgeRefresh(applicationContext)
    }

    override fun onMessageReceived(message: RemoteMessage) {
        super.onMessageReceived(message)

        // Hmelj's server sends a data-only FCM message (deliberately no top-level
        // `notification` block) with the whole notification described as ONE JSON string
        // in data["payload"]: {title, body, tag, unreadTotal, badgeOnly,
        // data:{accountId,folder,uid}, actions}.
        // Parse that first; fall back to a flat {notification:{title,body}} or flat
        // data["title"]/data["body"] shape for any other/simpler sender.
        var title: String? = null
        var body: String? = null
        var tag: String? = null
        var routeDataJson: String? = null
        var unreadTotal: Int = -1
        var badgeOnly = false
        // The pieces of `data` an action button needs to act on this one
        // message, pulled out separately from the opaque routing JSON above
        // (which is forwarded to the page verbatim on a plain tap).
        var accountId: String? = null
        var folder: String? = null
        var uid: String? = null
        var actions: org.json.JSONArray? = null
        // Calendar reminders travel the same FCM path as mail and are told
        // apart by `kind` — see server/calendarReminders.js#payloadFor. They
        // need a different channel, a different action button and, above all,
        // they must not touch the unread badge.
        var kind: String? = null
        var calendarId: String? = null
        var occurrenceStart: String? = null

        message.data["payload"]?.let { raw ->
            try {
                val obj = org.json.JSONObject(raw)
                obj.optString("title").takeIf { it.isNotEmpty() }?.let { title = it }
                obj.optString("body").takeIf { it.isNotEmpty() }?.let { body = it }
                obj.optString("tag").takeIf { it.isNotEmpty() }?.let { tag = it }
                kind = obj.optString("kind").takeIf { it.isNotEmpty() }
                obj.optJSONObject("data")?.let { d ->
                    routeDataJson = d.toString()
                    accountId = d.optString("accountId").takeIf { it.isNotEmpty() }
                    folder = d.optString("folder").takeIf { it.isNotEmpty() }
                    // uid is a number in the payload; every use of it here is as text.
                    uid = if (d.has("uid") && !d.isNull("uid")) d.get("uid").toString() else null
                    calendarId = d.optString("calendarId").takeIf { it.isNotEmpty() }
                    occurrenceStart = if (d.has("start") && !d.isNull("start")) d.get("start").toString() else null
                }
                actions = obj.optJSONArray("actions")
                if (obj.has("unreadTotal") && !obj.isNull("unreadTotal")) unreadTotal = obj.optInt("unreadTotal", -1)
                badgeOnly = obj.optBoolean("badgeOnly", false)
            } catch (e: Exception) {
                // Malformed payload JSON — fall through to the flat-field fallbacks below.
            }
        }

        // The server puts the recipient's real total unread in every push, so the badge
        // is correct even though this process may have been dead for hours and nothing
        // here could have worked it out. Applied BEFORE the enabled-check below: a badge
        // is not a notification, and it should track reality regardless.
        val isCalendar = kind == "calendar"
        // A follow-up reminder ("No reply yet") is about mail but is not new
        // mail: like a calendar reminder it stays off the mail channel, the
        // badge and the badge group, and has no message for tray buttons to act on.
        val isFollowUp = kind == "followup"
        val isReminder = isCalendar || isFollowUp
        // A calendar reminder carries no unread count and must never move the
        // badge — that number is the unread MAIL total, and a reminder blanking
        // or inflating it would make it stop matching what the app shows.
        if (!isReminder && unreadTotal >= 0) MailNotifications.setBadge(this, unreadTotal)

        // A badge-only push carries no title/body and exists purely to correct the
        // number above — sent when the total goes DOWN (mail read on another device),
        // which nothing else can tell a closed app. Show nothing for it.
        if (badgeOnly) return

        val finalTitle = title ?: message.notification?.title ?: message.data["title"] ?: getString(R.string.app_name)
        val finalBody = body ?: message.notification?.body ?: message.data["body"] ?: ""

        if (!NotificationManagerCompat.from(this).areNotificationsEnabled()) return
        // The process may have been started cold by this very message, so MainActivity
        // has never run — create the channels here too rather than assuming they exist
        // (on API 26+ notify() against a missing channel is silently dropped).
        MailNotifications.createChannels(this)

        val tapIntent = Intent(this, MainActivity::class.java).apply {
            // SINGLE_TOP matters: with CLEAR_TOP alone (and MainActivity's default
            // "standard" launch mode) Android DESTROYS and recreates the activity, so
            // onNewIntent never fires and the WebView reloads from scratch — losing
            // scroll position, view state and the message you were reading. Paired with
            // android:launchMode="singleTop" in the manifest.
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
            routeDataJson?.let { putExtra(MainActivity.EXTRA_PUSH_DATA, it) }
        }
        val pendingFlags = PendingIntent.FLAG_UPDATE_CURRENT or
                (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) PendingIntent.FLAG_IMMUTABLE else 0)
        // Use the sender's `tag` (e.g. a specific email/thread id) as a stable notification
        // id so a follow-up push for the same item replaces it instead of stacking a
        // duplicate — same idea as the Web Notifications API's own `tag` option.
        val id = tag?.hashCode() ?: System.currentTimeMillis().toInt()
        val pendingIntent = PendingIntent.getActivity(this, id, tapIntent, pendingFlags)

        val builder = NotificationCompat.Builder(
            this,
            when {
                isCalendar -> MailNotifications.CHANNEL_CALENDAR
                isFollowUp -> MailNotifications.CHANNEL_FOLLOWUP
                else -> MailNotifications.CHANNEL_MAIL
            },
        )
            .setSmallIcon(R.drawable.ic_launcher_foreground)
            .setContentTitle(finalTitle)
            .setContentText(finalBody)
            .setStyle(NotificationCompat.BigTextStyle().bigText(finalBody))
            .setAutoCancel(true)
            .setContentIntent(pendingIntent)
            // PRIORITY_HIGH is what gets a heads-up popup on pre-O devices and
            // correct ranking on newer ones. The CATEGORY differs: EVENT tells
            // the system (and Do Not Disturb, and Auto) that this is a calendar
            // reminder rather than a message, which is how a user who allows
            // "events" through DND but not "messages" gets what they asked for.
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(
                when {
                    isCalendar -> NotificationCompat.CATEGORY_EVENT
                    isFollowUp -> NotificationCompat.CATEGORY_REMINDER
                    else -> NotificationCompat.CATEGORY_MESSAGE
                }
            )

        // Only mail joins the badge group. Without this, badge-summing launchers
        // add +1 for the notification ON TOP of the summary's setNumber(total) —
        // and a calendar reminder joining it would inflate the unread MAIL count
        // by one for as long as it sat in the tray.
        if (!isReminder) builder.setGroup(MailNotifications.GROUP)

        val f = folder
        val u = uid
        val c = calendarId
        val startAt = occurrenceStart
        if (isCalendar) {
            // "Snooze", handled without opening the app — the same gesture
            // public/sw.js offers a browser, for the shell that has no Service
            // Worker at all. Needs the occurrence's own identity: a series has
            // one reminder per occurrence and snoozing must move exactly one.
            if (c != null && u != null && startAt != null) {
                addSnoozeAction(builder, actions, id, c, u, startAt)
            }
        } else if (!isFollowUp && f != null && u != null) {
            // "Mark as read" / "Delete" — see NotificationActionReceiver. Only
            // for a notification that stands for ONE message: the server's
            // "N more new messages" summary carries no uid, and there'd be
            // nothing for a button to act on.
            addTrayActions(builder, actions, id, accountId, f, u)
        }

        try {
            NotificationManagerCompat.from(this).notify(id, builder.build())
        } catch (e: SecurityException) {
            // POST_NOTIFICATIONS revoked between the check above and here.
        }
    }

    /**
     * Adds the two tray buttons.
     *
     * Titles come from the push payload's own `actions` array when it has them,
     * so the buttons are in the language the user reads Hmelj in (the server
     * localises them per recipient — see server/sync.js#notificationActions and
     * server/pushI18n.js). The bundled strings are the fallback for a payload
     * without them, e.g. an older server.
     */
    private fun addTrayActions(
        builder: NotificationCompat.Builder,
        actions: org.json.JSONArray?,
        notificationId: Int,
        accountId: String?,
        folder: String,
        uid: String,
    ) {
        val buttons = listOf(
            Triple(NotificationActionReceiver.ACTION_READ, R.string.notification_action_mark_read, R.drawable.ic_notif_mark_read),
            Triple(NotificationActionReceiver.ACTION_DELETE, R.string.notification_action_delete, R.drawable.ic_notif_delete),
        )
        for ((name, fallbackTitle, icon) in buttons) {
            builder.addAction(
                icon,
                titleFor(actions, name) ?: getString(fallbackTitle),
                NotificationActionReceiver.pendingIntent(this, name, notificationId, accountId, folder, uid),
            )
        }
    }

    /**
     * The "Snooze" button on a calendar reminder.
     *
     * One button, not two: dismissing is what closing the notification already
     * does, and a button whose only effect is to close it is one people press
     * expecting more. Title comes from the payload when it has one, so it is in
     * the language the user reads Hmelj in (server/calendarReminders.js
     * localises it per recipient).
     */
    private fun addSnoozeAction(
        builder: NotificationCompat.Builder,
        actions: org.json.JSONArray?,
        notificationId: Int,
        calendarId: String,
        uid: String,
        occurrenceStart: String,
    ) {
        builder.addAction(
            R.drawable.ic_notif_snooze,
            titleFor(actions, NotificationActionReceiver.ACTION_SNOOZE)
                ?: getString(R.string.notification_action_snooze),
            NotificationActionReceiver.snoozeIntent(this, notificationId, calendarId, uid, occurrenceStart),
        )
    }

    /** The payload's title for one action id, or null if it doesn't offer one. */
    private fun titleFor(actions: org.json.JSONArray?, name: String): String? {
        if (actions == null) return null
        for (i in 0 until actions.length()) {
            val a = actions.optJSONObject(i) ?: continue
            if (a.optString("action") == name) return a.optString("title").takeIf { it.isNotEmpty() }
        }
        return null
    }
}
