package com.hmelj.app

import android.app.Application

class HmeljApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        // Must happen here, not in MainActivity.onCreate(): a real push notification can
        // arrive via HmeljFirebaseMessagingService and start this process fresh, without
        // any Activity ever running first. createNotificationChannel() is idempotent, so
        // it's safe that MainActivity calls this too.
        //
        // BOTH channels are created here now. The badge channel used to be created only
        // in MainActivity, so on a cold push-start (exactly when the badge most needs
        // updating) it didn't exist and notify() was silently dropped on API 26+.
        MailNotifications.createChannels(this)
    }
}
