package com.termbridge.android.notifications

import com.termbridge.android.protocol.AgentChatBlock
import com.termbridge.android.protocol.AgentChatMessage

/** Notification text is prose from this conversation, never tool output or a status inference. */
data class AgentNotificationContent(val title: String, val body: String) {
    companion object {
        const val BODY_LIMIT = 4_000

        fun fromTranscript(messages: List<AgentChatMessage>, fallbackTitle: String): AgentNotificationContent? {
            val userIndex = messages.indexOfLast { it.role == "user" }
            // Without a user turn in the bounded snapshot we cannot associate an old answer with this alert.
            if (userIndex < 0) return null
            val user = messages[userIndex]
            val prompt = prose(user)
            val answer = messages.drop(userIndex + 1).lastOrNull {
                it.role == "assistant" && prose(it).isNotBlank() &&
                    (user.turnId == null || it.turnId == null || user.turnId == it.turnId)
            }?.let(::prose).orEmpty()
            if (answer.isBlank()) return prompt.takeIf(String::isNotBlank)?.let {
                AgentNotificationContent(title(it, fallbackTitle), "")
            }
            return AgentNotificationContent(title(prompt, fallbackTitle), bounded(answer, BODY_LIMIT))
        }

        fun title(value: String, fallback: String): String = bounded(
            clean(value).lineSequence().firstOrNull { it.isNotBlank() }
                ?.trim()?.trimStart('#', ' ', '*', '>')?.takeIf(String::isNotBlank)
                ?: clean(fallback).ifBlank { "TermBridge" }, 120,
        )

        fun clean(value: String): String = value.replace("\r\n", "\n")
            .replace(Regex("\u001B\\[[0-?]*[ -/]*[@-~]"), "")
            .filter { it == '\n' || it == '\t' || !it.isISOControl() }.trim()

        fun bounded(value: String, limit: Int): String {
            val text = clean(value)
            if (text.length <= limit) return text
            val end = (limit - 1).let { if (Character.isHighSurrogate(text[it - 1])) it - 1 else it }
            return text.substring(0, end).trimEnd() + "…"
        }

        private fun prose(message: AgentChatMessage): String = clean(message.blocks
            .filterIsInstance<AgentChatBlock.Text>().joinToString("\n\n") { it.text })
    }
}
