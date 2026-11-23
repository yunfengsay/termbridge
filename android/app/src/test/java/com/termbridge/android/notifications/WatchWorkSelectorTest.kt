package com.termbridge.android.notifications

import com.termbridge.android.protocol.SessionInfo
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class WatchWorkSelectorTest {
    @Test
    fun `approval outranks newer running work`() {
        val running = session("run", "working", 200)
        val approval = session("approve", "waiting", 100)
        assertEquals("approve", WatchWorkSelector.select(listOf(running, approval))?.sessionId)
    }

    @Test
    fun `done and snoozed work are excluded`() {
        val done = session("done", "done", 300)
        val snoozed = session("later", "blocked", 200)
        assertNull(WatchWorkSelector.select(listOf(done, snoozed)) { it.sessionId == "later" })
    }

    @Test
    fun `idle polling backs off`() {
        assertEquals(30_000L, WatchWorkSelector.pollIntervalMillis(listOf(session("done", "done", 1))))
        assertEquals(3_000L, WatchWorkSelector.pollIntervalMillis(listOf(session("run", "active", 1))))
    }

    private fun session(id: String, status: String, createdAt: Long) = SessionInfo(
        sessionId = id,
        command = "codex",
        cols = 80,
        rows = 24,
        createdAt = createdAt,
        viewers = 0,
        status = status,
    )
}
