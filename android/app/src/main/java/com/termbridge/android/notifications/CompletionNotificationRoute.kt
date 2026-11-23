package com.termbridge.android.notifications

import com.termbridge.android.data.ConnectionSettings

/** Stable identity and host routing for a completion notification conversation. */
data class CompletionNotificationRoute(
    val hostId: String,
    val sessionId: String,
) {
    val requestCode: Int = "$hostId\u0000$sessionId".hashCode()

    fun resolve(
        settings: ConnectionSettings,
        profiles: List<ConnectionSettings>,
    ): ConnectionSettings = profiles.firstOrNull { profile ->
        hostId.isNotBlank() && profile.hostId == hostId
    } ?: applyTo(settings)

    fun applyTo(settings: ConnectionSettings): ConnectionSettings =
        if (hostId.isBlank() || settings.hostId == hostId) {
            settings
        } else {
            settings.copy(hostId = hostId, hostName = "", profileAlias = "")
        }
}
