package com.termbridge.android.peer

import android.content.Context
import android.os.Build
import java.util.UUID

object AndroidPeerIdentity {
    private const val PREFERENCES = "termbridge_peer_identity"
    private const val DEVICE_ID = "device_id"

    fun deviceId(context: Context): String {
        val preferences = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
        preferences.getString(DEVICE_ID, null)?.takeIf(String::isNotBlank)?.let { return it }
        val generated = UUID.randomUUID().toString()
        preferences.edit().putString(DEVICE_ID, generated).apply()
        return generated
    }

    fun displayName(): String = listOf(Build.MANUFACTURER, Build.MODEL)
        .map(String::trim)
        .filter(String::isNotBlank)
        .distinctBy(String::lowercase)
        .joinToString(" ")
        .ifBlank { "Android device" }
}
