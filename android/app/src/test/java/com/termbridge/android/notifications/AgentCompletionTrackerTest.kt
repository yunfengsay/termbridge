package com.termbridge.android.notifications

import com.termbridge.android.protocol.SessionInfo
import org.junit.Assert.assertEquals
import org.junit.Test

class AgentCompletionTrackerTest {
    @Test
    fun `notifies only a working to done transition`() {
        val tracker = AgentCompletionTracker()
        assertEquals(emptyList<SessionInfo>(), tracker.update(listOf(session("done"))))
        assertEquals(emptyList<SessionInfo>(), tracker.update(listOf(session("working"))))
        assertEquals(listOf("herdr:w1:p1"), tracker.update(listOf(session("done"))).map(SessionInfo::sessionId))
        assertEquals(emptyList<SessionInfo>(), tracker.update(listOf(session("done"))))
    }

    private fun session(status: String) = SessionInfo(
        sessionId = "herdr:w1:p1",
        command = "project · codex",
        cols = 120,
        rows = 40,
        createdAt = 1,
        viewers = 0,
        source = "herdr",
        status = status,
    )
}
