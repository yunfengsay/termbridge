package com.termbridge.android.peer

import android.content.Context
import android.content.Intent
import android.provider.AlarmClock
import java.util.Calendar

object PhoneAlarmAction {
    fun createIntent(context: Context, request: PhoneActionRequest): Intent {
        val local = Calendar.getInstance().apply {
            timeInMillis = parsePhoneIsoTime(requireNotNull(request.scheduledAt))
        }
        val days = ArrayList(request.repeatDays.map(::calendarDay))
        return Intent(AlarmClock.ACTION_SET_ALARM).apply {
            putExtra(AlarmClock.EXTRA_HOUR, local.get(Calendar.HOUR_OF_DAY))
            putExtra(AlarmClock.EXTRA_MINUTES, local.get(Calendar.MINUTE))
            putExtra(AlarmClock.EXTRA_MESSAGE, request.title ?: "TermBridge")
            putExtra(AlarmClock.EXTRA_SKIP_UI, false)
            if (days.isNotEmpty()) putIntegerArrayListExtra(AlarmClock.EXTRA_DAYS, days)
            addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP)
        }.also { intent ->
            require(intent.resolveActivity(context.packageManager) != null) { "手机上没有可用的闹钟应用" }
        }
    }

    private fun calendarDay(day: String): Int = when (day) {
        "sun" -> Calendar.SUNDAY
        "mon" -> Calendar.MONDAY
        "tue" -> Calendar.TUESDAY
        "wed" -> Calendar.WEDNESDAY
        "thu" -> Calendar.THURSDAY
        "fri" -> Calendar.FRIDAY
        "sat" -> Calendar.SATURDAY
        else -> error("invalid alarm weekday")
    }
}
