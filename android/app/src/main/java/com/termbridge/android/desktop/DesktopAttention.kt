package com.termbridge.android.desktop

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.termbridge.android.R

object DesktopAttention {
    fun notify(context: Context, id: String, hostId: String) {
        val manager = context.getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= 26) manager.createNotificationChannel(NotificationChannel("desktop_attention", context.getString(R.string.remote_desktop), NotificationManager.IMPORTANCE_HIGH))
        val intent = PendingIntent.getActivity(context, id.hashCode(), RemoteDesktopActivity.intent(context, hostId), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val notification = NotificationCompat.Builder(context, "desktop_attention")
            .setSmallIcon(R.drawable.ic_desktop).setContentTitle(context.getString(R.string.remote_desktop))
            .setContentText(context.getString(R.string.desktop_attention_detail)).setContentIntent(intent)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE).setAutoCancel(true).setOnlyAlertOnce(true).build()
        try { NotificationManagerCompat.from(context).notify(id.hashCode(), notification) } catch (_: SecurityException) { /* Desktop entry remains available. */ }
    }
}
