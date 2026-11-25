package com.termbridge.android.ui

import com.termbridge.android.protocol.SessionInfo
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class SessionAdapterTest {
    private val session = SessionInfo(
        sessionId = "herdr:wA:p1",
        command = "termbridge · codex",
        cols = 120,
        rows = 40,
        createdAt = 1_000L,
        viewers = 0,
        source = "herdr",
        name = "TermBridge",
        workspace = "termbridge",
        paneId = "wA:p1",
        agent = "codex",
        status = "working",
        preview = "Working (1s)",
    )

    @Test
    fun `preview updates only rebind the preview text`() {
        assertEquals(
            SessionChange(preview = true),
            SessionDiff.getChangePayload(session, session.copy(preview = "Working (2s)")),
        )
    }

    @Test
    fun `viewer changes update meta and status without a full card bind`() {
        assertEquals(
            SessionChange(meta = true, status = true),
            SessionDiff.getChangePayload(session, session.copy(viewers = 1)),
        )
    }

    @Test
    fun `identity presentation changes use a full card bind`() {
        assertNull(SessionDiff.getChangePayload(session, session.copy(agent = "claude")))
        assertNull(SessionDiff.getChangePayload(session, session.copy(name = "TermBridge iOS")))
    }

    @Test
    fun `session order stays fixed when viewers, status, or title change`() {
        val alpha2 = session.copy(sessionId = "herdr:wA:p2", workspace = "alpha", paneId = "wA:p2", viewers = 0, status = "idle")
        val alpha10 = session.copy(sessionId = "herdr:wA:p10", workspace = "alpha", paneId = "wA:p10", viewers = 0, status = "done")
        val beta1 = session.copy(sessionId = "herdr:wB:p1", workspace = "beta", paneId = "wB:p1", viewers = 0, status = "idle")
        val ptyOld = session.copy(sessionId = "pty-1", source = "pty", workspace = null, paneId = null, createdAt = 100L)
        val ptyNew = session.copy(sessionId = "pty-2", source = "pty", workspace = null, paneId = null, createdAt = 200L)

        val initial = SessionOrder.sort(listOf(ptyNew, beta1, alpha10, ptyOld, alpha2))
        assertEquals(
            listOf("herdr:wA:p2", "herdr:wA:p10", "herdr:wB:p1", "pty-1", "pty-2"),
            initial.map(SessionInfo::sessionId),
        )

        // Tapping beta1 (viewers 0 -> 1) and changing alpha10 status/title must NOT move any row.
        val afterTap = SessionOrder.sort(
            listOf(
                ptyNew,
                beta1.copy(viewers = 2, status = "working"),
                alpha10.copy(name = "Renamed dynamically", status = "working", completedAt = 9_999L),
                ptyOld.copy(viewers = 1),
                alpha2,
            ),
        )
        assertEquals(initial.map(SessionInfo::sessionId), afterTap.map(SessionInfo::sessionId))
    }
}
