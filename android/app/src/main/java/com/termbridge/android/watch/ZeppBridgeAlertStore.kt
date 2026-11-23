package com.termbridge.android.watch

import android.content.Context
import androidx.core.content.edit
import org.json.JSONArray
import org.json.JSONObject

/** Keeps the small watch notification history across Android service restarts. */
object ZeppBridgeAlertStore {
    @Synchronized
    fun load(context: Context): List<ZeppBridgeAlert> = runCatching {
        decode(context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE).getString(KEY_ALERTS, null))
    }.getOrDefault(emptyList())

    @Synchronized
    fun append(context: Context, alert: ZeppBridgeAlert): List<ZeppBridgeAlert> {
        val alerts = merge(load(context), alert)
        context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE).edit {
            putString(KEY_ALERTS, encode(alerts))
        }
        return alerts
    }

    internal fun merge(existing: List<ZeppBridgeAlert>, alert: ZeppBridgeAlert): List<ZeppBridgeAlert> = buildList {
        add(alert)
        existing.filterTo(this) { it.id != alert.id }
    }.sortedByDescending(ZeppBridgeAlert::occurredAt).take(MAX_ALERTS)

    private fun encode(alerts: List<ZeppBridgeAlert>): String = JSONArray().apply {
        alerts.forEach { alert ->
            put(JSONObject().apply {
                put("id", alert.id)
                put("sessionId", alert.sessionId)
                put("title", alert.title)
                put("summary", alert.summary)
                put("status", alert.status)
                put("occurredAt", alert.occurredAt)
            })
        }
    }.toString()

    private fun decode(value: String?): List<ZeppBridgeAlert> {
        if (value.isNullOrBlank()) return emptyList()
        val array = JSONArray(value)
        return buildList {
            for (index in 0 until minOf(array.length(), MAX_ALERTS)) {
                val item = array.optJSONObject(index) ?: continue
                val id = item.optString("id").take(MAX_ID_CHARS)
                val sessionId = item.optString("sessionId").take(MAX_SESSION_ID_CHARS)
                if (id.isBlank() || sessionId.isBlank()) continue
                add(
                    ZeppBridgeAlert(
                        id = id,
                        sessionId = sessionId,
                        title = item.optString("title").take(MAX_TITLE_CHARS),
                        summary = item.optString("summary").take(MAX_SUMMARY_CHARS),
                        status = item.optString("status").take(MAX_STATUS_CHARS),
                        occurredAt = item.optLong("occurredAt").coerceAtLeast(0L),
                    ),
                )
            }
        }.sortedByDescending(ZeppBridgeAlert::occurredAt)
    }

    private const val PREFERENCES = "termbridge_zepp_alerts"
    private const val KEY_ALERTS = "alerts"
    private const val MAX_ALERTS = 16
    private const val MAX_ID_CHARS = 384
    private const val MAX_SESSION_ID_CHARS = 256
    private const val MAX_TITLE_CHARS = 96
    private const val MAX_SUMMARY_CHARS = 240
    private const val MAX_STATUS_CHARS = 32
}
