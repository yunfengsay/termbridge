package com.termbridge.android.brain

import com.termbridge.android.protocol.BrainConversationSummaryInfo
import com.termbridge.android.protocol.BrainDeliverableInfo
import com.termbridge.android.protocol.BrainMessageInfo
import com.termbridge.android.protocol.BrainTaskInfo
import com.termbridge.android.protocol.BrainToolResultInfo
import com.termbridge.android.protocol.ExecutionForkEventInfo
import com.termbridge.android.protocol.VoiceUsageInfo

/**
 * Owns Global Brain timeline snapshot data and transient streaming text drafts,
 * decoupled from Android Activity lifecycle and view plumbing.
 */
class BrainTimelineState {
    var allMessages: List<BrainMessageInfo> = emptyList()
        private set
    var brainMessages: List<BrainMessageInfo> = emptyList()
        private set
    var tasks: List<BrainTaskInfo> = emptyList()
        private set
    var toolResults: List<BrainToolResultInfo> = emptyList()
        private set
    var deliverables: List<BrainDeliverableInfo> = emptyList()
        private set
    var executionEvents: List<ExecutionForkEventInfo> = emptyList()
        private set
    var history: List<BrainConversationSummaryInfo> = emptyList()
        private set
    var voiceUsage: VoiceUsageInfo? = null
        private set

    private val streamingDrafts = LinkedHashMap<String, BrainMessageInfo>()

    fun applySnapshot(
        messages: List<BrainMessageInfo>,
        tasks: List<BrainTaskInfo>,
        toolResults: List<BrainToolResultInfo>,
        deliverables: List<BrainDeliverableInfo>,
        executionEvents: List<ExecutionForkEventInfo>,
        history: List<BrainConversationSummaryInfo>,
        voiceUsage: VoiceUsageInfo?,
    ) {
        allMessages = messages
        brainMessages = messages.filter { it.role == "brain" }
        this.tasks = tasks
        this.toolResults = toolResults
        this.deliverables = deliverables
        this.executionEvents = executionEvents
        this.history = history
        this.voiceUsage = voiceUsage
        // Retire streaming drafts once the authoritative persisted message lands in snapshot.
        val persistedIds = messages.mapTo(HashSet()) { it.id }
        streamingDrafts.keys.removeAll { draftRequestId -> "$draftRequestId-brain" in persistedIds }
        if (messages.isEmpty() && tasks.isEmpty() && executionEvents.isEmpty()) {
            streamingDrafts.clear()
        }
    }

    fun applyExecutionEvent(event: ExecutionForkEventInfo) {
        executionEvents = (executionEvents.filterNot { it.eventId == event.eventId } + event)
            .sortedBy(ExecutionForkEventInfo::createdAt)
            .takeLast(300)
        if (event.phase in setOf("fork_failed", "fork_cancelled")) {
            streamingDrafts.remove(event.requestId)
        }
    }

    /** Upserts a live streaming assistant reply bubble for incremental Global text output. */
    fun applyTextDelta(requestId: String, text: String, final: Boolean, now: Long = System.currentTimeMillis()): Boolean {
        val clean = text.trim()
        if (requestId.isBlank() || clean.isEmpty()) return false
        val messageId = "$requestId-brain"
        if (allMessages.any { it.id == messageId }) {
            streamingDrafts.remove(requestId)
            return false
        }
        val existing = streamingDrafts[requestId]
        val createdAt = existing?.createdAt ?: maxOf(now, (allMessages.maxOfOrNull { it.createdAt } ?: 0L) + 1L)
        streamingDrafts[requestId] = BrainMessageInfo(
            id = messageId,
            role = "brain",
            text = clean,
            createdAt = createdAt,
            modality = "text",
            voiceStatus = if (final) "completed" else "streaming",
        )
        return true
    }

    fun clearStreamingDraft(requestId: String) {
        streamingDrafts.remove(requestId)
    }

    fun clearStreamingDrafts() {
        streamingDrafts.clear()
    }

    /** Snapshot messages merged with any in-flight streaming assistant drafts not yet persisted. */
    fun mergedMessages(): List<BrainMessageInfo> {
        if (streamingDrafts.isEmpty()) return allMessages
        val persistedIds = allMessages.mapTo(HashSet()) { it.id }
        val activeDrafts = streamingDrafts.values.filterNot { it.id in persistedIds }
        return if (activeDrafts.isEmpty()) allMessages else allMessages + activeDrafts
    }

    fun buildTimelineItems(): List<BrainTimelineItem> = buildBrainTimelineItems(
        messages = mergedMessages(),
        tasks = tasks,
        toolResults = toolResults,
        deliverables = deliverables,
        executionEvents = executionEvents,
    )
}
