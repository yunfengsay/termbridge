package com.termbridge.android.notifications

import com.termbridge.android.protocol.AgentChatBlock
import com.termbridge.android.protocol.AgentChatMessage
import org.junit.Assert.*
import org.junit.Test

class AgentNotificationContentTest {
    private fun message(role: String, text: String, turn: String? = null) =
        AgentChatMessage(role, role, listOf(AgentChatBlock.Text(text)), null, "transcript", 1, turn)

    @Test fun `uses current question and complete latest prose instead of generic agent state`() {
        val answer = "已修复通知。\n\n" + "展开后可以查看详细内容。".repeat(40)
        val result = AgentNotificationContent.fromTranscript(listOf(
            message("user", "优化通知显示\n请保留详细内容", "two"),
            message("assistant", "我正在检查", "two"),
            message("assistant", answer, "two"),
        ), "code")!!
        assertEquals("优化通知显示", result.title)
        assertEquals(answer, result.body)
        assertTrue(result.body.length > 240)
    }

    @Test fun `never shows an answer from before the latest question or another turn`() {
        val result = AgentNotificationContent.fromTranscript(listOf(
            message("user", "旧问题", "one"), message("assistant", "旧答案", "one"),
            message("user", "当前问题", "two"), message("assistant", "迟到的旧答案", "one"),
        ), "code")!!
        assertEquals("当前问题", result.title)
        assertEquals("", result.body)
        assertNull(AgentNotificationContent.fromTranscript(listOf(message("assistant", "没有所属问题")), "code"))
    }

    @Test fun `tool arguments outputs and images never become notification prose`() {
        val tool = AgentChatMessage("tool", "assistant", listOf(
            AgentChatBlock.ToolCall("read", "private argument"),
            AgentChatBlock.ToolResult("private output", false),
            AgentChatBlock.ImageRef("file:///private.png", null, null),
        ), null, "transcript", 3)
        val result = AgentNotificationContent.fromTranscript(listOf(
            message("user", "查看结果"), message("assistant", "正文"), tool,
        ), "code")!!
        assertEquals("正文", result.body)
    }

    @Test fun `bounded text preserves paragraphs and never splits a surrogate pair`() {
        val body = "a".repeat(3_998) + "😀" + "ending"
        val result = AgentNotificationContent.bounded(body, 4_000)
        assertTrue(result.length <= 4_000)
        assertFalse(result.any { Character.isSurrogate(it) })
        assertTrue(result.endsWith("…"))
        assertEquals("问题", AgentNotificationContent.title("\u001b[31m# 问题\u001b[0m\n次行", "code"))
    }
}
