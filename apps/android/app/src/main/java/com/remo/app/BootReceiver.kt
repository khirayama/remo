package com.remo.app

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat

/**
 * Recording is a foreground service, which the system does not bring back
 * after the phone restarts or the app is updated. Without this, a restart
 * would silently stop the timeline until the app is opened again.
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED && intent.action != Intent.ACTION_MY_PACKAGE_REPLACED) return
        if (!AutomaticCaptureService.isEnabled(context) || !hasLocationPermission(context)) return
        // Starting a location service from the background needs the "all the
        // time" location permission. Without it the system refuses, and the
        // user is asked to open the app instead.
        val started = runCatching { AutomaticCaptureService.setEnabled(context, true) }
            .onFailure { Log.w(TAG, "Unable to resume recording after restart: ${it.message}") }
            .isSuccess
        if (!started) remindToOpen(context)
    }

    private fun remindToOpen(context: Context) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return
        val manager = context.getSystemService(NotificationManager::class.java) ?: return
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            manager.createNotificationChannel(NotificationChannel(CHANNEL_ID, "記録の再開", NotificationManager.IMPORTANCE_DEFAULT))
        }
        val openApp = PendingIntent.getActivity(context, 0, Intent(context, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        manager.notify(
            NOTIFICATION_ID,
            NotificationCompat.Builder(context, CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_notification)
                .setColor(ContextCompat.getColor(context, R.color.brand_green))
                .setContentTitle("位置情報の記録が停止しています")
                .setContentText("端末の再起動後は、Remoを開くと記録を再開します")
                .setAutoCancel(true)
                .setContentIntent(openApp)
                .build(),
        )
    }

    private companion object {
        const val TAG = "BootReceiver"
        const val CHANNEL_ID = "rem_capture_resume"
        const val NOTIFICATION_ID = 43
    }
}
