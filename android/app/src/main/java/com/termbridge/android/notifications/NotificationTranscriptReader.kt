package com.termbridge.android.notifications

import com.termbridge.android.protocol.AgentChatMessage
import com.termbridge.android.protocol.ControlMessage
import com.termbridge.android.protocol.SessionInfo

/** Owned by the monitor's main thread. One short subscription at a time; no persistent background transcript. */
class NotificationTranscriptReader(
    private val send: (Map<String, Any?>) -> Boolean,
    private val scheduleTimeout: (() -> Unit) -> (() -> Unit),
    private val onContent: (Request, AgentNotificationContent) -> Unit,
) {
    data class Request(val token: String, val notificationId: Int, val session: SessionInfo)
    private data class Active(val request: Request, val generation: Int, var cancelTimeout: () -> Unit = {})
    private val queue = ArrayDeque<Request>()
    private var active: Active? = null
    private var generation = 0

    fun enqueue(request: Request) {
        if (!request.session.isHerdr) return
        queue.removeAll { it.session.sessionId == request.session.sessionId }
        if (active?.request?.session?.sessionId == request.session.sessionId) finish()
        if (queue.size >= 8) queue.removeFirst()
        queue.addLast(request)
        advance()
    }

    fun retain(sessions: List<SessionInfo>) {
        val current = sessions.associateBy { it.sessionId }
        fun valid(request: Request): Boolean = current[request.session.sessionId]?.let {
            it.status == request.session.status && it.completedAt == request.session.completedAt
        } == true
        queue.removeAll { !valid(it) }
        if (active?.request?.let { !valid(it) } == true) finish()
        advance()
    }

    @Suppress("UNCHECKED_CAST")
    fun accept(message: ControlMessage) {
        val pending = active ?: return
        if (message.type != "agent_chat_snapshot" || message.string("requestId") != pending.request.token ||
            message.string("conversationId") != pending.request.session.sessionId ||
            message.int("generation") != pending.generation) return
        val messages = (message.fields["messages"] as? List<*>).orEmpty().mapNotNull {
            (it as? Map<String, Any?>)?.let(AgentChatMessage::fromMap)
        }
        finish()
        if (message.string("error").isNullOrBlank()) {
            AgentNotificationContent.fromTranscript(messages, pending.request.session.displayName)?.let {
                onContent(pending.request, it)
            }
        }
        advance()
    }

    fun clear() { queue.clear(); finish() }

    private fun finish() {
        val pending = active ?: return
        active = null
        pending.cancelTimeout()
        send(mapOf("t" to "agent_chat_unsubscribe", "conversationId" to pending.request.session.sessionId))
    }

    private fun advance() {
        if (active != null || queue.isEmpty()) return
        val request = queue.removeFirst()
        val pending = Active(request, ++generation)
        active = pending
        pending.cancelTimeout = scheduleTimeout {
            if (active === pending) { finish(); advance() }
        }
        if (!send(mapOf("t" to "agent_chat_subscribe", "requestId" to request.token,
                "conversationId" to request.session.sessionId, "generation" to pending.generation))) {
            finish(); advance()
        }
    }
}
