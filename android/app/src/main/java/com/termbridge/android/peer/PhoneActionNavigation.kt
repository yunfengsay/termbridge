package com.termbridge.android.peer

import android.content.ContentUris
import android.content.Context
import android.content.Intent
import android.provider.AlarmClock
import android.provider.CalendarContract
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import com.termbridge.android.R

enum class PhoneActionDestination { APPROVAL, ALARMS, CALENDAR, DETAILS }

/** Local receipts, never model-authored URLs or titles, authorize navigation. */
fun phoneActionDestination(request: PhoneActionRequest?, result: PhoneActionResult?): PhoneActionDestination? {
    if (result == null) return if (request != null) PhoneActionDestination.APPROVAL else null
    if (result.state == "awaiting_user" && request != null) return PhoneActionDestination.APPROVAL
    if (result.state != "completed") return PhoneActionDestination.DETAILS
    return when (result.action) {
        "alarm.create" -> PhoneActionDestination.ALARMS
        "calendar.list", "calendar.create", "calendar.update", "calendar.delete" -> PhoneActionDestination.CALENDAR
        else -> PhoneActionDestination.DETAILS
    }
}

object PhoneActionNavigation {
    fun canOpen(context: Context, actionId: String): Boolean {
        val store = PhoneActionStore(context)
        return phoneActionDestination(store.load(actionId), store.result(actionId)) != null
    }

    /** Opening a completed receipt must never repeat a native mutation. */
    fun open(context: Context, actionId: String): Boolean {
        val store = PhoneActionStore(context)
        val request = store.load(actionId)
        val result = store.result(actionId)
        val destination = phoneActionDestination(request, result) ?: return false
        try {
            when (destination) {
                PhoneActionDestination.APPROVAL -> PhoneActionActivity.open(context, actionId)
                PhoneActionDestination.ALARMS -> context.startActivity(Intent(AlarmClock.ACTION_SHOW_ALARMS))
                PhoneActionDestination.CALENDAR -> {
                    val eventId = if (result?.action != "calendar.delete")
                        result?.data?.get("eventId")?.toString()?.toLongOrNull()?.takeIf { it > 0L } else null
                    val intent = if (eventId != null) Intent(Intent.ACTION_VIEW,
                        ContentUris.withAppendedId(CalendarContract.Events.CONTENT_URI, eventId))
                    else Intent.makeMainSelectorActivity(Intent.ACTION_MAIN, Intent.CATEGORY_APP_CALENDAR)
                    context.startActivity(intent)
                }
                PhoneActionDestination.DETAILS -> showDetails(context, result?.summary.orEmpty())
            }
        } catch (_: android.content.ActivityNotFoundException) {
            showDetails(context, context.getString(R.string.phone_action_app_unavailable))
        } catch (_: SecurityException) {
            showDetails(context, context.getString(R.string.phone_action_app_unavailable))
        }
        return true
    }

    private fun showDetails(context: Context, text: String) {
        MaterialAlertDialogBuilder(context).setMessage(text)
            .setPositiveButton(android.R.string.ok, null).show()
    }
}
