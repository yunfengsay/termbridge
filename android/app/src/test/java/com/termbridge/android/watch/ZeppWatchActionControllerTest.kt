package com.termbridge.android.watch

import com.termbridge.android.protocol.ControlMessage
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ZeppWatchActionControllerTest {
    @Test
    fun fixedActionsSendBoundedContextualGlobalRequests() {
        val sent = mutableListOf<List<Pair<String, Any?>>>()
        val controller = ZeppWatchActionController(
            isHostReady = { true },
            sendControl = { fields -> sent += fields; true },
            now = { 10L },
        )

        val snapshot = controller.submit(ZeppWatchAction.SUMMARIZE, "herdr:w1:p1")

        assertEquals(ZeppWatchActionSnapshot.STATE_THINKING, snapshot.state)
        assertEquals("brain_send", sent.single().toMap()["t"])
        assertEquals("herdr:w1:p1", sent.single().toMap()["sourceSessionId"])
        assertTrue((sent.single().toMap()["text"] as String).contains("只总结"))
        assertFalse((sent.single().toMap()["text"] as String).contains("shell"))
    }

    @Test
    fun completionUsesTheAuthoritativeBrainReceipt() {
        val sent = mutableListOf<List<Pair<String, Any?>>>()
        val receipts = mutableListOf<ZeppWatchActionSnapshot>()
        var clock = 10L
        val controller = ZeppWatchActionController(
            isHostReady = { true },
            sendControl = { fields -> sent += fields; true },
            onReceipt = { receipts += it },
            now = { clock },
        )
        val pending = controller.submit(ZeppWatchAction.CONTINUE, "herdr:w2:p4")
        val requestId = sent.first().toMap()["requestId"] as String
        clock = 20L

        assertTrue(controller.handle(ControlMessage("brain_execution_event", mapOf(
            "event" to mapOf(
                "eventId" to "event-1",
                "forkId" to "fork-1",
                "requestId" to requestId,
                "phase" to "fork_completed",
                "createdAt" to 20L,
            ),
        ))))
        assertEquals("brain_snapshot", sent.last().toMap()["t"])
        assertTrue(controller.handle(ControlMessage("brain_snapshot_result", mapOf(
            "messages" to listOf(mapOf(
                "id" to "$requestId-brain",
                "role" to "brain",
                "text" to "已继续 voice-agent，并收到回执。",
                "createdAt" to 20L,
            )),
        ))))

        val completed = controller.snapshot(pending.id)!!
        assertEquals(ZeppWatchActionSnapshot.STATE_DONE, completed.state)
        assertEquals("已继续 voice-agent，并收到回执。", completed.summary)
        assertEquals(listOf(completed), receipts)
    }
}
