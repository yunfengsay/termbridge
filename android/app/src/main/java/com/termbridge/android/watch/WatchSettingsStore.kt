package com.termbridge.android.watch

import android.content.Context
import androidx.core.content.edit

data class WatchSettings(
    val deviceAddress: String = "",
    val deviceName: String = "",
    val transport: WatchTransport = WatchTransport.AUTO,
    val batteryLevel: Int? = null,
    val lastReportedAt: Long = 0L,
    val connected: Boolean = false,
) {
    val paired: Boolean get() = deviceAddress.isNotBlank()
}

object WatchSettingsStore {
    private const val PREFERENCES = "termbridge_watch"
    private const val DEVICE_ADDRESS = "device_address"
    private const val DEVICE_NAME = "device_name"
    private const val TRANSPORT = "transport"
    private const val BATTERY_LEVEL = "battery_level"
    private const val LAST_REPORTED_AT = "last_reported_at"
    private const val CONNECTED = "connected"

    fun load(context: Context): WatchSettings {
        val preferences = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
        return WatchSettings(
            deviceAddress = preferences.getString(DEVICE_ADDRESS, "").orEmpty(),
            deviceName = preferences.getString(DEVICE_NAME, "").orEmpty(),
            transport = WatchTransport.fromWireName(preferences.getString(TRANSPORT, null)),
            batteryLevel = if (preferences.contains(BATTERY_LEVEL)) {
                preferences.getInt(BATTERY_LEVEL, 0).coerceIn(0, 100)
            } else {
                null
            },
            lastReportedAt = preferences.getLong(LAST_REPORTED_AT, 0L).coerceAtLeast(0L),
            connected = preferences.getBoolean(CONNECTED, false),
        )
    }

    fun save(context: Context, settings: WatchSettings) {
        context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE).edit {
            putString(DEVICE_ADDRESS, settings.deviceAddress)
            putString(DEVICE_NAME, settings.deviceName)
            putString(TRANSPORT, settings.transport.wireName)
            settings.batteryLevel?.let { putInt(BATTERY_LEVEL, it.coerceIn(0, 100)) }
                ?: remove(BATTERY_LEVEL)
            putLong(LAST_REPORTED_AT, settings.lastReportedAt.coerceAtLeast(0L))
            putBoolean(CONNECTED, settings.connected)
        }
    }

    fun updateTelemetry(context: Context, batteryLevel: Int, reportedAt: Long) {
        val current = load(context)
        if (!current.paired) return
        save(
            context,
            current.copy(
                batteryLevel = batteryLevel.coerceIn(0, 100),
                lastReportedAt = reportedAt.coerceAtLeast(0L),
                connected = true,
            ),
        )
    }

    fun updateConnection(context: Context, connected: Boolean) {
        val current = load(context)
        if (!current.paired || current.connected == connected) return
        save(context, current.copy(connected = connected))
    }

    fun clear(context: Context) {
        context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE).edit { clear() }
    }
}
