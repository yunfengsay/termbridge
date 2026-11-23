package com.termbridge.android.peer

import android.content.ContentUris
import android.content.ContentValues
import android.content.Context
import android.os.CancellationSignal
import android.os.OperationCanceledException
import android.provider.CalendarContract
import android.util.Log
import java.util.TimeZone
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

object PhoneCalendarActions {
    fun execute(
        context: Context,
        request: PhoneActionRequest,
        cancellationSignal: CancellationSignal? = null,
    ): PhoneActionResult = when (request.action) {
        "calendar.list" -> list(context, request, cancellationSignal)
        "calendar.create" -> create(context, request)
        "calendar.update" -> update(context, request)
        "calendar.delete" -> delete(context, request)
        else -> error("unsupported calendar action")
    }

    private fun list(
        context: Context,
        request: PhoneActionRequest,
        externalCancellation: CancellationSignal?,
    ): PhoneActionResult {
        val start = parseTime(requireNotNull(request.startsAt))
        val end = parseTime(requireNotNull(request.endsAt))
        require(end > start) { "日历结束时间必须晚于开始时间" }
        val uri = CalendarContract.Instances.CONTENT_URI.buildUpon().also {
            ContentUris.appendId(it, start)
            ContentUris.appendId(it, end)
        }.build()
        val events = mutableListOf<Map<String, Any?>>()
        val cancellation = externalCancellation ?: CancellationSignal()
        val timedOut = AtomicBoolean(false)
        val timeout = timeoutExecutor.schedule({
            timedOut.set(true)
            cancellation.cancel()
        }, QUERY_TIMEOUT_SECONDS, TimeUnit.SECONDS)
        val startedAt = System.nanoTime()
        try {
            context.contentResolver.query(
                uri,
                arrayOf(
                    CalendarContract.Instances.EVENT_ID,
                    CalendarContract.Instances.TITLE,
                    CalendarContract.Instances.BEGIN,
                    CalendarContract.Instances.END,
                    CalendarContract.Instances.EVENT_LOCATION,
                    CalendarContract.Instances.CALENDAR_DISPLAY_NAME,
                ),
                null,
                null,
                "${CalendarContract.Instances.BEGIN} ASC",
                cancellation,
            )?.use { cursor ->
                while (cursor.moveToNext() && events.size < MAX_EVENTS) {
                    events += mapOf(
                        "eventId" to cursor.getLong(0).toString(),
                        "title" to cursor.getString(1).orEmpty().take(200),
                        "startsAt" to cursor.getLong(2).toString(),
                        "endsAt" to cursor.getLong(3).toString(),
                        "location" to cursor.getString(4)?.take(300),
                        "calendar" to cursor.getString(5)?.take(160),
                    )
                }
            }
        } catch (error: OperationCanceledException) {
            if (timedOut.get()) {
                error("Calendar query timed out after ${QUERY_TIMEOUT_SECONDS}s; retry when the phone is responsive")
            }
            throw error
        } finally {
            timeout.cancel(false)
            Log.i(TAG, "calendar.list elapsedMs=${(System.nanoTime() - startedAt) / 1_000_000} count=${events.size}")
        }
        return PhoneActionResult(
            request.actionId,
            request.action,
            "completed",
            "已读取该时间段的 ${events.size} 个日历事件",
            mapOf("events" to events, "startsAt" to start.toString(), "endsAt" to end.toString()),
        )
    }

    private fun create(context: Context, request: PhoneActionRequest): PhoneActionResult {
        val calendarId = writableCalendarId(context)
        val startsAt = parseTime(requireNotNull(request.startsAt))
        val endsAt = parseTime(requireNotNull(request.endsAt))
        require(endsAt > startsAt) { "日历结束时间必须晚于开始时间" }
        val values = ContentValues().apply {
            put(CalendarContract.Events.CALENDAR_ID, calendarId)
            put(CalendarContract.Events.TITLE, requireNotNull(request.title))
            put(CalendarContract.Events.DTSTART, startsAt)
            put(CalendarContract.Events.DTEND, endsAt)
            put(CalendarContract.Events.EVENT_TIMEZONE, TimeZone.getDefault().id)
            request.description?.let { put(CalendarContract.Events.DESCRIPTION, it) }
            request.location?.let { put(CalendarContract.Events.EVENT_LOCATION, it) }
        }
        val uri = context.contentResolver.insert(CalendarContract.Events.CONTENT_URI, values)
            ?: error("无法创建日历事件")
        val eventId = ContentUris.parseId(uri).toString()
        return PhoneActionResult(
            request.actionId,
            request.action,
            "completed",
            "已创建日历事件：${request.title}",
            mapOf("eventId" to eventId, "startsAt" to startsAt.toString(), "endsAt" to endsAt.toString()),
        )
    }

    private fun update(context: Context, request: PhoneActionRequest): PhoneActionResult {
        val eventId = requireNotNull(request.eventId).toLongOrNull() ?: error("日历事件 ID 无效")
        val values = ContentValues().apply {
            request.title?.let { put(CalendarContract.Events.TITLE, it) }
            request.description?.let { put(CalendarContract.Events.DESCRIPTION, it) }
            request.location?.let { put(CalendarContract.Events.EVENT_LOCATION, it) }
            request.startsAt?.let { put(CalendarContract.Events.DTSTART, parseTime(it)) }
            request.endsAt?.let { put(CalendarContract.Events.DTEND, parseTime(it)) }
        }
        val count = context.contentResolver.update(
            ContentUris.withAppendedId(CalendarContract.Events.CONTENT_URI, eventId),
            values,
            null,
            null,
        )
        require(count > 0) { "没有找到要修改的日历事件" }
        return PhoneActionResult(
            request.actionId,
            request.action,
            "completed",
            "已更新日历事件",
            mapOf("eventId" to eventId.toString()),
        )
    }

    private fun delete(context: Context, request: PhoneActionRequest): PhoneActionResult {
        val eventId = requireNotNull(request.eventId).toLongOrNull() ?: error("日历事件 ID 无效")
        val count = context.contentResolver.delete(
            ContentUris.withAppendedId(CalendarContract.Events.CONTENT_URI, eventId),
            null,
            null,
        )
        require(count > 0) { "没有找到要删除的日历事件" }
        return PhoneActionResult(
            request.actionId,
            request.action,
            "completed",
            "已删除日历事件",
            mapOf("eventId" to eventId.toString()),
        )
    }

    private fun writableCalendarId(context: Context): Long {
        var fallback: Long? = null
        context.contentResolver.query(
            CalendarContract.Calendars.CONTENT_URI,
            arrayOf(
                CalendarContract.Calendars._ID,
                CalendarContract.Calendars.IS_PRIMARY,
            ),
            "${CalendarContract.Calendars.VISIBLE}=1 AND ${CalendarContract.Calendars.CALENDAR_ACCESS_LEVEL}>=?",
            arrayOf(CalendarContract.Calendars.CAL_ACCESS_CONTRIBUTOR.toString()),
            null,
        )?.use { cursor ->
            while (cursor.moveToNext()) {
                val id = cursor.getLong(0)
                if (fallback == null) fallback = id
                if (cursor.getInt(1) == 1) return id
            }
        }
        return fallback ?: error("没有可写入的日历")
    }

    private fun parseTime(value: String): Long = parsePhoneIsoTime(value)

    private const val MAX_EVENTS = 30
    private const val QUERY_TIMEOUT_SECONDS = 15L
    private const val TAG = "TermbridgeCalendar"
    private val timeoutExecutor = Executors.newSingleThreadScheduledExecutor { runnable ->
        Thread(runnable, "termbridge-calendar-timeout").apply { isDaemon = true }
    }
}
