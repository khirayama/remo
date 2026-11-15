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
        if (!AutomaticCaptureService.isEnabled(context)) return
        // Starting a location service from the background needs the "all the
        // time" location permission on Android 10 and later. Without it the
        // system refuses when the service calls startForeground, so the app is
        // asked to open instead.
        if (currentLocationAccess(context) != LocationAccess.ALWAYS) {
            remindToOpen(context)
            return
        }
        val started = runCatching { AutomaticCaptureService.setEnabled(context, true) }
            .onFailure { Log.w(TAG, "Unable to resume recording after restart: ${it.message}") }
            .isSuccess
        if (!started) remindToOpen(context)
    }

    private companion object {
        const val TAG = "BootReceiver"
    }
}

/**
 * Asks the user to open the app to resume recording, for a resume the system
 * does not allow (no background location permission, or a start from the
 * background that it refused).
 */
internal fun remindToOpen(context: Context) {
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
            .setContentText("Remoを開くと記録を再開します")
            .setAutoCancel(true)
            .setContentIntent(openApp)
            .build(),
    )
}

private const val CHANNEL_ID = "rem_capture_resume"
private const val NOTIFICATION_ID = 43
