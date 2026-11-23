package com.termbridge.android.brain

import com.termbridge.android.protocol.BrainMessageInfo
import com.termbridge.android.protocol.BrainDeliverableInfo
import com.termbridge.android.protocol.BrainTaskInfo
import com.termbridge.android.protocol.BrainToolResultInfo
import com.termbridge.android.protocol.VoiceToolViewInfo
import com.termbridge.android.protocol.VoiceToolViewItemInfo
import com.termbridge.android.protocol.ExecutionForkEventInfo
import org.junit.Assert.assertEquals
import org.junit.Test

class BrainTimelineTest {
    @Test
    fun `asynchronous tool outcome updates stale approval text without reopening completed fork`() {
        val traces = buildBrainExecutionTraces(listOf(
            ExecutionForkEventInfo("1", "fork", "request", "tool_completed", 100L,
                callId = "call", toolName = "phone_action", summary = "点按确认"),
            ExecutionForkEventInfo("2", "fork", "request", "fork_completed", 110L),
            ExecutionForkEventInfo("3", "fork", "request", "tool_completed", 120L,
                callId = "call", toolName = "phone_action", summary = "已收到确认"),
        ))
        assertEquals("fork_completed", traces.single().phase)
        assertEquals("已收到确认", traces.single().tools.single().summary)
    }
    @Test
    fun `one durable tool result stays grouped as one Global conversation card`() {
        val items = buildBrainTimelineItems(
            messages = listOf(BrainMessageInfo("message", "user", "Show agents", 100L)),
            tasks = listOf(BrainTaskInfo("task", "request", "Show agents", "codex", "completed", 200L, 200L)),
            toolResults = listOf(
                BrainToolResultInfo(
                    id = "tool",
                    requestId = "voice-1",
                    callId = "call-1",
                    toolName = "list_agents",
                    createdAt = 150L,
                    view = VoiceToolViewInfo(
                        "agent_list",
                        "Agents",
                        listOf(
                            VoiceToolViewItemInfo("herdr:wA:p1", "termbridge", sessionId = "herdr:wA:p1"),
                            VoiceToolViewItemInfo("herdr:w9:p1", "phone-brain", sessionId = "herdr:w9:p1"),
                        ),
                    ),
                ),
            ),
            deliverables = listOf(
                BrainDeliverableInfo(
                    id = "preview",
                    runId = "task",
                    kind = "preview",
                    title = "Web preview",
                    createdAt = 175L,
                    url = "https://example.test/preview",
                ),
            ),
        )

        assertEquals(
            listOf("message:message", "tool:tool", "deliverable:preview", "task:task"),
            items.map(BrainTimelineItem::stableId),
        )
        assertEquals(
            listOf("herdr:wA:p1", "herdr:w9:p1"),
            (items[1] as BrainTimelineItem.ToolResult).value.view.items.map(VoiceToolViewItemInfo::id),
        )
    }

    @Test
    fun `timeline follows only first load or genuinely new content while user is at bottom`() {
        assertEquals(true, shouldFollowLatestTimelineItem(true, false, null, "message:1"))
        assertEquals(false, shouldFollowLatestTimelineItem(false, true, "message:1", "message:1"))
        assertEquals(true, shouldFollowLatestTimelineItem(false, true, "message:1", "message:2"))
        assertEquals(false, shouldFollowLatestTimelineItem(false, false, "message:1", "message:2"))
    }

    @Test
    fun `execution events collapse into one card with one latest row per tool call`() {
        val events = listOf(
            ExecutionForkEventInfo("1", "fork-1", "request-1", "fork_started", 100L, model = "qwen3.8-flash"),
            ExecutionForkEventInfo("2", "fork-1", "request-1", "tool_started", 110L, callId = "call-a", toolName = "inspect_workspace", summary = "正在读取"),
            ExecutionForkEventInfo("3", "fork-1", "request-1", "tool_completed", 120L, callId = "call-a", toolName = "inspect_workspace", summary = "已读取 4 个 Agent"),
            ExecutionForkEventInfo("4", "fork-1", "request-1", "tool_started", 130L, callId = "call-b", toolName = "dispatch_agent", summary = "正在派发"),
        )
        val traces = buildBrainExecutionTraces(events)
        assertEquals(1, traces.size)
        assertEquals(listOf("call-a", "call-b"), traces.single().tools.map(BrainExecutionToolStep::callId))
        assertEquals("已读取 4 个 Agent", traces.single().tools.first().summary)
        assertEquals("tool_started", traces.single().phase)
    }
}
