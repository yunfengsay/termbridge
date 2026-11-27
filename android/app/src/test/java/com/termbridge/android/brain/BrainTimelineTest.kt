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

    @Test
    fun `consecutive tool cards merge into one card and deduplicate repeated rows`() {
        fun decision(id: String, at: Long, agent: String, sessionId: String) = BrainToolResultInfo(
            id = id,
            requestId = "req-$id",
            callId = "call-$id",
            toolName = "completion_review",
            createdAt = at,
            view = VoiceToolViewInfo(
                kind = "decision_list",
                title = "需要你决策",
                items = listOf(
                    VoiceToolViewItemInfo(
                        id = "$sessionId-$id",
                        title = agent,
                        detail = "判断服务未完成，未自动派发或重试",
                        status = "idle",
                        timestamp = at,
                        sessionId = sessionId,
                    ),
                ),
            ),
        )

        val items = buildBrainTimelineItems(
            messages = listOf(
                BrainMessageInfo("m1", "user", "hi", 500L),
            ),
            tasks = emptyList(),
            toolResults = listOf(
                decision("t1", 100L, "架构师", "herdr:w2P:p3"),
                decision("t2", 200L, "架构师", "herdr:w2P:p3"),
                decision("t3", 300L, "astra-v8", "herdr:w2A:p1"),
                decision("t4", 400L, "实时流模型", "herdr:w2R:p1"),
                decision("t5", 600L, "架构师", "herdr:w2P:p3"),
            ),
        )

        // First 4 consecutive tool cards before m1 merge into 1; t5 after m1 stays separate.
        assertEquals(3, items.size)
        val merged = items[0] as BrainTimelineItem.ToolResult
        assertEquals("tool:t1..t4", merged.stableId)
        assertEquals("需要你决策", merged.value.view.title)
        assertEquals(
            listOf("架构师 ×2", "astra-v8", "实时流模型"),
            merged.value.view.items.map(VoiceToolViewItemInfo::title),
        )
        assertEquals(200L, merged.value.view.items[0].timestamp)
        assertEquals("message:m1", items[1].stableId)
        assertEquals("tool:t5", items[2].stableId)
    }

    @Test
    fun `timeline state streams text deltas and retires draft once authoritative snapshot arrives`() {
        val state = BrainTimelineState()
        state.applySnapshot(
            messages = listOf(BrainMessageInfo("req-1", "user", "你好", 100L)),
            tasks = emptyList(),
            toolResults = emptyList(),
            deliverables = emptyList(),
            executionEvents = emptyList(),
            history = emptyList(),
            voiceUsage = null,
        )
        assertEquals(true, state.applyTextDelta("req-1", "正在", final = false, now = 110L))
        assertEquals("streaming", state.mergedMessages().last().voiceStatus)
        assertEquals("正在", state.mergedMessages().last().text)

        assertEquals(true, state.applyTextDelta("req-1", "正在处理中", final = false, now = 120L))
        assertEquals(2, state.mergedMessages().size)
        assertEquals("正在处理中", state.mergedMessages().last().text)

        // Once authoritative snapshot arrives with req-1-brain, draft is cleanly replaced.
        state.applySnapshot(
            messages = listOf(
                BrainMessageInfo("req-1", "user", "你好", 100L),
                BrainMessageInfo("req-1-brain", "brain", "已完成回复", 130L),
            ),
            tasks = emptyList(),
            toolResults = emptyList(),
            deliverables = emptyList(),
            executionEvents = emptyList(),
            history = emptyList(),
            voiceUsage = null,
        )
        assertEquals(2, state.mergedMessages().size)
        assertEquals("已完成回复", state.mergedMessages().last().text)
        assertEquals(null, state.mergedMessages().last().voiceStatus)
    }

    @Test
    fun `voice diagnostics controller formats live counters and resets cleanly`() {
        var clock = 10_000L
        val diag = VoiceDiagnosticsController { clock }
        diag.resetForCall()
        diag.recordFrame()
        diag.recordAudible(true)
        diag.recordVad(0.85f, 0.50f)
        diag.recordCaptured(2048)
        diag.recordSent(1024)
        clock = 12_000L
        val text = diag.formatStatus(active = true, hasRequestId = true, remoteReady = true)
        assertEquals(true, text.contains("采集 1帧/2KB → 已发 1KB(人声2KB) [语音▶]"))
        assertEquals(true, text.contains("最近: 通话开始 · 2s前"))
        assertEquals("", diag.formatStatus(active = false, hasRequestId = false, remoteReady = false))
    }
}
