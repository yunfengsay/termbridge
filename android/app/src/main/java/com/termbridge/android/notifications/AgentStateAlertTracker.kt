package com.termbridge.android.notifications

import com.termbridge.android.protocol.SessionInfo
import java.util.Locale

data class AgentStateAlert(
    val session: SessionInfo,
    val status: String,
    val occurredAt: Long,
)

/** Emits only meaningful status transitions after the initial session snapshot. */
class AgentStateAlertTracker {
    private var initialized = false
    private var previous = emptyMap<String, String>()

    fun update(sessions: List<SessionInfo>, now: Long = System.currentTimeMillis()): List<AgentStateAlert> {
        val alerts = if (initialized) {
            sessions.mapNotNull { session ->
                val status = session.status.orEmpty().lowercase(Locale.US)
                val oldStatus = previous[session.sessionId]
                if (status !in alertStatuses || status == oldStatus) null
                else AgentStateAlert(session, status, now.coerceAtLeast(0L))
            }
        } else {
            emptyList()
        }
        previous = sessions.associate { it.sessionId to it.status.orEmpty().lowercase(Locale.US) }
        initialized = true
        return alerts
    }

    fun reset() {
        initialized = false
        previous = emptyMap()
    }

    private companion object {
        val alertStatuses = setOf("waiting", "approval", "blocked", "failed", "error")
    }
}
