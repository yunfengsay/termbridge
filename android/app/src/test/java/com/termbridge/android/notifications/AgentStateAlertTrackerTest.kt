package com.termbridge.android.notifications

import com.termbridge.android.protocol.SessionInfo
import org.junit.Assert.assertEquals
import org.junit.Test

class AgentStateAlertTrackerTest {
    @Test
    fun `does not flood alerts on initial snapshot`() {
        val tracker = AgentStateAlertTracker()

        assertEquals(emptyList<AgentStateAlert>(), tracker.update(listOf(session("approval")), now = 10L))
    }

    @Test
    fun `emits attention and failure transitions once`() {
        val tracker = AgentStateAlertTracker()
        tracker.update(listOf(session("working")), now = 10L)

        assertEquals(listOf("approval"), tracker.update(listOf(session("approval")), now = 20L).map { it.status })
        assertEquals(emptyList<AgentStateAlert>(), tracker.update(listOf(session("approval")), now = 30L))
        assertEquals(listOf("failed"), tracker.update(listOf(session("failed")), now = 40L).map { it.status })
    }

    @Test
    fun `reset makes the next snapshot a baseline`() {
        val tracker = AgentStateAlertTracker()
        tracker.update(listOf(session("working")))
        tracker.reset()

        assertEquals(emptyList<AgentStateAlert>(), tracker.update(listOf(session("blocked"))))
    }

    private fun session(status: String) = SessionInfo(
        sessionId = "herdr:w1:p1",
        command = "termbridge · codex",
        cols = 120,
        rows = 40,
        createdAt = 1,
        viewers = 0,
        source = "herdr",
        status = status,
    )
}
