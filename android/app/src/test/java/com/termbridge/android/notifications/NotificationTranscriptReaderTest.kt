package com.termbridge.android.notifications

import com.termbridge.android.protocol.ControlMessage
import com.termbridge.android.protocol.SessionInfo
import org.junit.Assert.*
import org.junit.Test

class NotificationTranscriptReaderTest {
    private val sent = mutableListOf<Map<String, Any?>>()
    private val deadlines = mutableListOf<() -> Unit>()
    private val canceled = mutableSetOf<Int>()
    private val results = mutableListOf<Pair<String, AgentNotificationContent>>()
    private val reader = NotificationTranscriptReader(
        send = { sent += it; true },
        scheduleTimeout = { task ->
            val id = deadlines.size; deadlines += task
            val cancel: () -> Unit = { canceled += id }; cancel
        },
        onContent = { request, content -> results += request.token to content },
    )
    private fun request(id: String, token: String = id) = NotificationTranscriptReader.Request(token, id.hashCode(),
        SessionInfo(id, "codex", 0, 0, 1, 0, source = "herdr", name = "code", status = "done", completedAt = 12))
    private fun snapshot(request: Map<String, Any?>) = ControlMessage("agent_chat_snapshot", request + mapOf(
        "messages" to listOf(
            mapOf("id" to "user", "role" to "user", "blocks" to listOf(mapOf("type" to "text", "text" to "任务标题"))),
            mapOf("id" to "answer", "role" to "assistant", "blocks" to listOf(mapOf("type" to "text", "text" to "详细回答"))),
        ),
    ))

    @Test fun `serializes subscriptions and unsubscribes immediately after the one snapshot`() {
        reader.enqueue(request("a")); reader.enqueue(request("b"))
        assertEquals(1, sent.size)
        reader.accept(snapshot(sent.first()))
        assertEquals(listOf("agent_chat_subscribe", "agent_chat_unsubscribe", "agent_chat_subscribe"), sent.map { it["t"] })
        assertEquals("b", sent.last()["conversationId"])
        assertEquals("详细回答", results.single().second.body)
        assertTrue(0 in canceled)
    }

    @Test fun `host switch clear and request replacement reject late generations`() {
        reader.enqueue(request("same", "old")); val old = sent.last()
        reader.clear(); reader.enqueue(request("same", "new"))
        reader.accept(snapshot(old))
        reader.accept(snapshot(sent.last() + ("generation" to old["generation"])))
        assertTrue(results.isEmpty())
        val current = sent.last()
        reader.accept(snapshot(current))
        assertEquals("new", results.single().first)
    }

    @Test fun `timeout releases old hosts and ignores their late replies`() {
        reader.enqueue(request("a")); val old = sent.last()
        reader.enqueue(request("b")); deadlines.first().invoke()
        assertEquals("b", sent.last()["conversationId"])
        reader.accept(snapshot(old)); assertTrue(results.isEmpty())
        reader.accept(snapshot(sent.last())); assertEquals("b", results.single().first)
    }

    @Test fun `a new turn or removed session cancels pending detail instead of updating old alerts`() {
        val a = request("a"); reader.enqueue(a); val old = sent.last()
        reader.retain(listOf(a.session.copy(status = "working")))
        reader.accept(snapshot(old)); assertTrue(results.isEmpty())
        assertEquals("agent_chat_unsubscribe", sent.last()["t"])
        assertTrue(0 in canceled)
    }

    @Test fun `failures and non agent sessions keep existing notification without extra delivery`() {
        reader.enqueue(request("pty").let { it.copy(session = it.session.copy(source = "pty")) })
        assertTrue(sent.isEmpty())
        reader.enqueue(request("agent"))
        reader.accept(snapshot(sent.last()).let { it.copy(fields = it.fields + ("error" to "unavailable")) })
        assertTrue(results.isEmpty())
        assertEquals("agent_chat_unsubscribe", sent.last()["t"])
    }

    @Test fun `bounds bursts to the active read plus eight queued notifications`() {
        repeat(30) { reader.enqueue(request("session-$it")) }
        repeat(12) { sent.lastOrNull { it["t"] == "agent_chat_subscribe" }?.let { reader.accept(snapshot(it)) } }
        assertEquals(9, results.size)
        assertEquals("session-29", results.last().first)
    }
}
