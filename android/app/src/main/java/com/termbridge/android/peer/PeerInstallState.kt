package com.termbridge.android.peer

import android.content.Context

internal object PeerInstallState {
    private const val PREFERENCES = "termbridge_peer_installs"

    fun observe(context: Context, changed: () -> Unit): () -> Unit {
        val preferences = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
        val listener = android.content.SharedPreferences.OnSharedPreferenceChangeListener { _, key ->
            if (key?.endsWith(".status") == true || key?.endsWith(".updated") == true) changed()
        }
        preferences.registerOnSharedPreferenceChangeListener(listener)
        return { preferences.unregisterOnSharedPreferenceChangeListener(listener) }
    }

    fun save(
        context: Context,
        artifactId: String,
        status: String,
        packageName: String? = null,
        message: String? = null,
        sessionId: Int? = null,
    ) {
        context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE).edit().apply {
            putString("$artifactId.status", status)
            packageName?.let { putString("$artifactId.package", it) }
            message?.let { putString("$artifactId.message", it) }
            sessionId?.let { putInt("$artifactId.session", it) }
            putLong("$artifactId.updated", System.currentTimeMillis())
        }.apply()
    }

    fun read(context: Context, artifactId: String): Map<String, Any?> {
        val preferences = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
        val status = preferences.getString("$artifactId.status", null) ?: "unknown"
        val sessionId = preferences.getInt("$artifactId.session", -1)
        return buildMap {
            put("artifactId", artifactId)
            put("status", status)
            preferences.getString("$artifactId.package", null)?.let { put("packageName", it) }
            preferences.getString("$artifactId.message", null)?.let { put("message", it) }
            if (sessionId >= 0) put("sessionId", sessionId)
            put("updatedAt", preferences.getLong("$artifactId.updated", 0L))
        }
    }
}
