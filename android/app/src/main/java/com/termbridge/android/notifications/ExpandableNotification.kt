package com.termbridge.android.notifications

import android.content.Context
import android.app.Notification
import android.app.NotificationManager
import androidx.core.app.NotificationCompat
import io.noties.markwon.Markwon

/** Shared collapsed preview and expanded prose for Agent and Global result notifications. */
object ExpandableNotification {
    const val DETAILS_TOKEN = "notificationDetailsToken"

    fun updateIfCurrent(context: Context, notificationId: Int, token: String, content: AgentNotificationContent) {
        val manager = context.getSystemService(NotificationManager::class.java)
        // A dismissed, replaced or snoozed alert must never be recreated by a late transcript.
        val current = manager.activeNotifications.firstOrNull {
            it.id == notificationId && it.notification.extras.getString(DETAILS_TOKEN) == token
        }?.notification ?: return
        val builder = apply(context, NotificationCompat.Builder(context, current), content.title,
            content.body.ifBlank { context.getString(com.termbridge.android.R.string.notification_no_reply) },
            current.extras.getCharSequence(Notification.EXTRA_SUB_TEXT)?.toString().orEmpty())
        try { manager.notify(notificationId, builder.setSilent(true).build()) }
        catch (_: SecurityException) { /* Permission can be revoked while reading. */ }
    }

    fun apply(context: Context, builder: NotificationCompat.Builder, title: String, body: String, source: String): NotificationCompat.Builder {
        val heading = AgentNotificationContent.title(title, context.getString(com.termbridge.android.R.string.app_name))
        val text = AgentNotificationContent.bounded(body, AgentNotificationContent.BODY_LIMIT)
        // Core Markdown only: no image loader or network access in the notification renderer.
        val rendered = Markwon.create(context).toMarkdown(text)
        return builder.setContentTitle(heading)
            .setContentText(rendered)
            .setSubText(source)
            .setStyle(NotificationCompat.BigTextStyle().setBigContentTitle(heading).bigText(rendered).setSummaryText(source))
            .setOnlyAlertOnce(true)
    }
}
