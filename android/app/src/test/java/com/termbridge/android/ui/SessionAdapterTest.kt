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
}
