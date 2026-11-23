package com.termbridge.android.notifications

import com.termbridge.android.protocol.SessionInfo

class AgentCompletionTracker {
    private var initialized = false
    private var previous = emptyMap<String, String?>()

    fun update(sessions: List<SessionInfo>): List<SessionInfo> {
        val completed = if (initialized) {
            sessions.filter { session ->
                session.isHerdr &&
                    session.status.equals("done", ignoreCase = true) &&
                    previous[session.sessionId].equals("working", ignoreCase = true)
            }
        } else {
            emptyList()
        }
        previous = sessions.associate { it.sessionId to it.status }
        initialized = true
        return completed
    }

    fun reset() {
        initialized = false
        previous = emptyMap()
    }
}
