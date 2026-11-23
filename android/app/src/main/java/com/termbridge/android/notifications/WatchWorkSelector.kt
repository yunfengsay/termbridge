package com.termbridge.android.notifications

import com.termbridge.android.protocol.SessionInfo

/** Pure priority policy shared by watch publishing and unit tests. */
object WatchWorkSelector {
    val activeStatuses = setOf("working", "running", "active", "waiting", "approval", "blocked")

    fun select(
        sessions: List<SessionInfo>,
        isSnoozed: (SessionInfo) -> Boolean = { false },
    ): SessionInfo? = sessions.asSequence()
        .filter { it.status.orEmpty().lowercase() in activeStatuses && !isSnoozed(it) }
        .sortedWith(
            compareBy<SessionInfo> { rank(it.status.orEmpty()) }
                .thenByDescending { it.completedAt ?: it.createdAt },
        )
        .firstOrNull()

    fun pollIntervalMillis(sessions: List<SessionInfo>): Long =
        if (sessions.any { it.status.orEmpty().lowercase() in activeStatuses }) 3_000L else 30_000L

    private fun rank(status: String): Int = when (status.lowercase()) {
        "waiting", "approval", "blocked" -> 0
        "working", "running", "active" -> 1
        else -> 2
    }
}
