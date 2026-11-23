package com.termbridge.android.watch

import com.termbridge.android.protocol.MessagePackCodec
import com.termbridge.android.protocol.SessionInfo
import org.junit.Assert.assertEquals
import org.junit.Test

class WatchNotificationPayloadTest {
    @Test
    fun `completion keeps the host and conversation identity`() {
        val session = SessionInfo(
            sessionId = "herdr:wA:p3",
            command = "termbridge · codex",
            cols = 120,
            rows = 40,
            createdAt = 1,
            viewers = 0,
            source = "herdr",
            name = "手表修复",
            status = "done",
            completedAt = 1_788_192_000_000,
            preview = "通知和详情链路已通过测试",
        )

        val decoded = WatchNotificationPayload.decode(
            WatchNotificationPayload.fromSession("office-mini", session).encode(),
        )

        assertEquals("office-mini", decoded.hostId)
        assertEquals(session.sessionId, decoded.sessionId)
        assertEquals("手表修复", decoded.title)
        assertEquals(session.preview, decoded.body)
        assertEquals(session.completedAt, decoded.completedAt)
    }

    @Test
    fun `watch open action routes back to the exact conversation`() {
        val bytes = MessagePackCodec.packMap(
            linkedMapOf(
                "version" to 1,
                "hostId" to "office-mini",
                "sessionId" to "herdr:wA:p3",
                "title" to "通知修复",
            ),
        )

        assertEquals(
            WatchConversationRoute("office-mini", "herdr:wA:p3", "通知修复"),
            WatchNotificationPayload.decodeConversationOpen(bytes),
        )
    }
}
