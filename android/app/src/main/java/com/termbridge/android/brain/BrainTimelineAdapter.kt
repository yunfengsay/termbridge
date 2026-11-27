package com.termbridge.android.brain

import android.text.format.DateUtils
import android.view.Gravity
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import androidx.core.content.ContextCompat
import androidx.recyclerview.widget.DiffUtil
import androidx.recyclerview.widget.ListAdapter
import androidx.recyclerview.widget.RecyclerView
import com.termbridge.android.R
import com.termbridge.android.databinding.ItemBrainMessageBinding
import com.termbridge.android.databinding.ItemBrainTaskBinding
import com.termbridge.android.protocol.BrainDeliverableInfo
import com.termbridge.android.protocol.BrainMessageInfo
import com.termbridge.android.protocol.BrainTaskInfo
import com.termbridge.android.protocol.BrainToolResultInfo
import com.termbridge.android.protocol.ExecutionForkEventInfo
import com.termbridge.android.protocol.VoiceToolViewItemInfo

sealed interface BrainTimelineItem {
    val stableId: String
    val sortAt: Long

    data class Message(val value: BrainMessageInfo) : BrainTimelineItem {
        override val stableId: String = "message:${value.id}"
        override val sortAt: Long = value.createdAt
    }

    data class Task(val value: BrainTaskInfo) : BrainTimelineItem {
        override val stableId: String = "task:${value.taskId}"
        override val sortAt: Long = value.createdAt
    }

    data class ToolResult(val value: BrainToolResultInfo) : BrainTimelineItem {
        override val stableId: String = "tool:${value.id}"
        override val sortAt: Long = value.createdAt
    }

    data class Deliverable(val value: BrainDeliverableInfo) : BrainTimelineItem {
        override val stableId: String = "deliverable:${value.id}"
        override val sortAt: Long = value.createdAt
    }

    data class Execution(val value: BrainExecutionTrace) : BrainTimelineItem {
        override val stableId: String = "execution:${value.forkId}"
        override val sortAt: Long = value.startedAt
    }
}

data class BrainExecutionToolStep(
    val callId: String,
    val name: String,
    val phase: String,
    val summary: String,
)

data class BrainExecutionTrace(
    val forkId: String,
    val model: String,
    val phase: String,
    val startedAt: Long,
    val tools: List<BrainExecutionToolStep>,
)

fun buildBrainExecutionTraces(events: List<ExecutionForkEventInfo>): List<BrainExecutionTrace> =
    events.groupBy(ExecutionForkEventInfo::forkId).mapNotNull { (forkId, forkEvents) ->
        val ordered = forkEvents.sortedBy(ExecutionForkEventInfo::createdAt)
        val first = ordered.firstOrNull() ?: return@mapNotNull null
        val latest = ordered.last()
        val tools = ordered.filter { it.callId != null && it.toolName != null }
            .groupBy { it.callId.orEmpty() }
            .mapNotNull { (callId, callEvents) ->
                val event = callEvents.lastOrNull() ?: return@mapNotNull null
                BrainExecutionToolStep(
                    callId = callId,
                    name = event.toolName.orEmpty(),
                    phase = event.phase,
                    summary = event.summary ?: event.toolName.orEmpty(),
                )
            }
        BrainExecutionTrace(
            forkId = forkId,
            model = ordered.mapNotNull(ExecutionForkEventInfo::model).lastOrNull() ?: "qwen3.8-flash",
            phase = ordered.lastOrNull { it.phase in setOf("fork_completed", "fork_failed", "fork_cancelled") }?.phase ?: latest.phase,
            startedAt = first.createdAt,
            tools = tools,
        )
    }.sortedBy(BrainExecutionTrace::startedAt)

fun buildBrainTimelineItems(
    messages: List<BrainMessageInfo>,
    tasks: List<BrainTaskInfo>,
    toolResults: List<BrainToolResultInfo>,
    deliverables: List<BrainDeliverableInfo> = emptyList(),
    executionEvents: List<ExecutionForkEventInfo> = emptyList(),
): List<BrainTimelineItem> {
    val sorted = buildList {
        messages.forEach { add(BrainTimelineItem.Message(it)) }
        tasks.forEach { add(BrainTimelineItem.Task(it)) }
        toolResults.forEach { add(BrainTimelineItem.ToolResult(it)) }
        deliverables.forEach { add(BrainTimelineItem.Deliverable(it)) }
        buildBrainExecutionTraces(executionEvents).forEach { add(BrainTimelineItem.Execution(it)) }
    }.sortedWith(
        compareBy<BrainTimelineItem> { it.sortAt }.thenBy {
            when (it) {
                is BrainTimelineItem.Message -> 0
                is BrainTimelineItem.ToolResult -> 1
                is BrainTimelineItem.Deliverable -> 2
                is BrainTimelineItem.Task -> 3
                is BrainTimelineItem.Execution -> 1
            }
        },
    )
    return coalesceConsecutiveToolResults(sorted)
}

internal fun coalesceConsecutiveToolResults(items: List<BrainTimelineItem>): List<BrainTimelineItem> {
    if (items.size <= 1) return items
    val result = ArrayList<BrainTimelineItem>(items.size)
    val run = ArrayList<BrainTimelineItem.ToolResult>()

    fun flushRun() {
        if (run.isEmpty()) return
        if (run.size == 1) {
            result.add(run[0])
        } else {
            result.add(mergeToolResultRun(run))
        }
        run.clear()
    }

    for (item in items) {
        if (item is BrainTimelineItem.ToolResult) {
            run.add(item)
        } else {
            flushRun()
            result.add(item)
        }
    }
    flushRun()
    return result
}

private fun mergeToolResultRun(run: List<BrainTimelineItem.ToolResult>): BrainTimelineItem.ToolResult {
    val first = run.first().value
    val last = run.last().value

    data class DedupeKey(
        val sessionId: String,
        val title: String,
        val detail: String,
        val subtitle: String,
        val status: String,
    )

    val counts = LinkedHashMap<DedupeKey, Int>()
    val latestByKey = LinkedHashMap<DedupeKey, VoiceToolViewItemInfo>()
    for (entry in run) {
        for (row in entry.value.view.items) {
            val key = DedupeKey(
                sessionId = row.sessionId.orEmpty(),
                title = row.title,
                detail = row.detail.orEmpty(),
                subtitle = row.subtitle.orEmpty(),
                status = row.status.orEmpty(),
            )
            counts[key] = (counts[key] ?: 0) + 1
            // Re-insert so the latest occurrence moves to the end in chronological order.
            latestByKey.remove(key)
            latestByKey[key] = row
        }
    }

    val mergedItems = latestByKey.map { (key, row) ->
        val repeat = counts[key] ?: 1
        if (repeat > 1) row.copy(title = "${row.title} ×$repeat") else row
    }

    val distinctTitles = run.map { it.value.view.title.trim() }.filter { it.isNotEmpty() }.distinct()
    val mergedTitle = when {
        distinctTitles.isEmpty() -> last.view.title
        distinctTitles.size == 1 -> distinctTitles.first()
        distinctTitles.size == 2 -> "${distinctTitles[0]} · ${distinctTitles[1]}"
        else -> "${distinctTitles.last()} 等 ${distinctTitles.size} 项"
    }

    return BrainTimelineItem.ToolResult(
        last.copy(
            id = "${first.id}..${last.id}",
            view = last.view.copy(
                title = mergedTitle,
                items = mergedItems,
            ),
        ),
    )
}

fun shouldFollowLatestTimelineItem(
    firstRender: Boolean,
    wasAtBottom: Boolean,
    previousLastId: String?,
    nextLastId: String?,
): Boolean = firstRender || (wasAtBottom && previousLastId != nextLastId)

class BrainTimelineAdapter(
    private val openTask: (BrainTaskInfo) -> Unit,
    private val openToolItem: (VoiceToolViewItemInfo) -> Unit,
    private val openDeliverable: (BrainDeliverableInfo) -> Unit,
    private val markdown: com.termbridge.android.content.ArtifactMarkdown,
) : ListAdapter<BrainTimelineItem, RecyclerView.ViewHolder>(Diff) {
    private val expandedToolCards = hashSetOf<String>()
    override fun getItemViewType(position: Int): Int = when (getItem(position)) {
        is BrainTimelineItem.Message -> TYPE_MESSAGE
        is BrainTimelineItem.Task -> TYPE_TASK
        is BrainTimelineItem.ToolResult -> TYPE_TOOL_RESULT
        is BrainTimelineItem.Deliverable -> TYPE_DELIVERABLE
        is BrainTimelineItem.Execution -> TYPE_EXECUTION
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): RecyclerView.ViewHolder =
        when (viewType) {
            TYPE_MESSAGE -> MessageHolder(
                ItemBrainMessageBinding.inflate(LayoutInflater.from(parent.context), parent, false),
            )
            TYPE_TASK -> TaskHolder(
                ItemBrainTaskBinding.inflate(LayoutInflater.from(parent.context), parent, false),
            )
            TYPE_DELIVERABLE -> DeliverableHolder(
                ItemBrainTaskBinding.inflate(LayoutInflater.from(parent.context), parent, false),
            )
            TYPE_EXECUTION -> ExecutionHolder(
                ItemBrainTaskBinding.inflate(LayoutInflater.from(parent.context), parent, false),
            )
            else -> ToolResultHolder(VoiceToolResultView(parent.context).asTimelineItem())
        }

    override fun onBindViewHolder(holder: RecyclerView.ViewHolder, position: Int) {
        when (val item = getItem(position)) {
            is BrainTimelineItem.Message -> (holder as MessageHolder).bind(item.value)
            is BrainTimelineItem.Task -> (holder as TaskHolder).bind(item.value)
            is BrainTimelineItem.ToolResult -> (holder as ToolResultHolder).bind(item.value)
            is BrainTimelineItem.Deliverable -> (holder as DeliverableHolder).bind(item.value)
            is BrainTimelineItem.Execution -> (holder as ExecutionHolder).bind(item.value)
        }
    }

    private inner class MessageHolder(
        private val binding: ItemBrainMessageBinding,
    ) : RecyclerView.ViewHolder(binding.root) {
        fun bind(message: BrainMessageInfo) = with(binding) {
            val fromUser = message.role == "user"
            val params = card.layoutParams as FrameLayout.LayoutParams
            params.gravity = if (fromUser) Gravity.END else Gravity.START
            card.layoutParams = params
            card.setCardBackgroundColor(
                ContextCompat.getColor(root.context, if (fromUser) R.color.surface_variant else R.color.surface),
            )
            card.strokeWidth = if (fromUser) 0 else root.resources.displayMetrics.density.toInt().coerceAtLeast(1)
            card.setStrokeColor(ContextCompat.getColor(root.context, R.color.line))
            markdown.bind(this.message, message.text)
            val author = root.context.getString(
                when {
                    fromUser -> R.string.brain_you
                    message.voiceStatus == "interrupted" -> R.string.brain_voice_interrupted
                    message.voiceStatus == "streaming" && message.modality == "voice" -> R.string.brain_voice_streaming
                    message.voiceStatus == "streaming" -> R.string.brain_text_streaming
                    message.modality == "voice" -> R.string.brain_voice_reply
                    else -> R.string.brain
                },
            )
            meta.text = root.context.getString(R.string.brain_message_meta, author, relativeTime(message.createdAt))
        }

        private fun relativeTime(timestamp: Long): CharSequence =
            DateUtils.getRelativeTimeSpanString(
                timestamp,
                System.currentTimeMillis(),
                DateUtils.MINUTE_IN_MILLIS,
                DateUtils.FORMAT_ABBREV_RELATIVE,
            )
    }

    private inner class TaskHolder(
        private val binding: ItemBrainTaskBinding,
    ) : RecyclerView.ViewHolder(binding.root) {
        fun bind(task: BrainTaskInfo) = with(binding) {
            val (statusLabel, dot) = when (task.status) {
                "queued" -> R.string.brain_queued to R.drawable.status_dot_idle
                "dispatched" -> R.string.brain_dispatched to R.drawable.status_dot_active
                "completed" -> R.string.brain_completed to R.drawable.status_dot_active
                "cancelled" -> R.string.brain_cancelled to R.drawable.status_dot_idle
                else -> R.string.brain_failed to R.drawable.status_dot_error
            }
            status.setText(statusLabel)
            statusDot.setBackgroundResource(dot)
            agent.text = root.context.getString(R.string.brain_agent_meta, task.agent)
            detail.text = task.error ?: task.text
            val canOpen = task.status == "dispatched" && !task.sessionId.isNullOrBlank()
            openRun.visibility = if (canOpen) View.VISIBLE else View.GONE
            card.isClickable = canOpen
            card.isFocusable = canOpen
            card.setOnClickListener(if (canOpen) View.OnClickListener { openTask(task) } else null)
        }
    }

    private inner class ToolResultHolder(
        private val view: VoiceToolResultView,
    ) : RecyclerView.ViewHolder(view) {
        fun bind(result: BrainToolResultInfo) {
            val groupKey = result.id.substringBefore("..")
            view.bind(
                view = result.view,
                openItem = openToolItem,
                markdown = markdown,
                expanded = groupKey in expandedToolCards,
                onToggleExpanded = { expand ->
                    if (expand) expandedToolCards.add(groupKey) else expandedToolCards.remove(groupKey)
                },
            )
        }
    }

    private inner class DeliverableHolder(
        private val binding: ItemBrainTaskBinding,
    ) : RecyclerView.ViewHolder(binding.root) {
        fun bind(deliverable: BrainDeliverableInfo) = with(binding) {
            status.text = deliverable.kind.replaceFirstChar(Char::uppercase)
            statusDot.setBackgroundResource(R.drawable.status_dot_active)
            agent.text = deliverable.title
            detail.text = deliverable.path ?: deliverable.url.orEmpty()
            openRun.visibility = if (deliverable.isOpenable) View.VISIBLE else View.GONE
            card.isClickable = deliverable.isOpenable
            card.isFocusable = deliverable.isOpenable
            card.setOnClickListener(
                if (deliverable.isOpenable) View.OnClickListener { openDeliverable(deliverable) } else null,
            )
        }
    }

    private class ExecutionHolder(
        private val binding: ItemBrainTaskBinding,
    ) : RecyclerView.ViewHolder(binding.root) {
        fun bind(trace: BrainExecutionTrace) = with(binding) {
            val active = trace.phase !in setOf("fork_completed", "fork_failed", "fork_cancelled")
            status.setText(when (trace.phase) {
                "fork_cancelled" -> R.string.silent_cancelled
                "fork_failed" -> R.string.silent_failed
                "fork_completed" -> R.string.silent_done
                else -> R.string.silent_running
            })
            statusDot.setBackgroundResource(
                if (trace.phase == "fork_failed") R.drawable.status_dot_error
                else R.drawable.status_dot_active,
            )
            agent.text = trace.model
            detail.text = if (trace.tools.isEmpty()) {
                if (active) "正在分析上下文…" else "未调用工具"
            } else {
                trace.tools.joinToString("\n") { step ->
                    val mark = when (step.phase) {
                        "tool_completed" -> "✓"
                        "tool_failed" -> "!"
                        else -> "•"
                    }
                    "$mark ${step.summary}"
                }
            }
            openRun.visibility = View.GONE
            card.isClickable = false
            card.isFocusable = false
            card.setOnClickListener(null)
        }
    }

    private object Diff : DiffUtil.ItemCallback<BrainTimelineItem>() {
        override fun areItemsTheSame(oldItem: BrainTimelineItem, newItem: BrainTimelineItem): Boolean =
            oldItem.stableId == newItem.stableId

        override fun areContentsTheSame(oldItem: BrainTimelineItem, newItem: BrainTimelineItem): Boolean =
            oldItem == newItem
    }

    private companion object {
        const val TYPE_MESSAGE = 1
        const val TYPE_TASK = 2
        const val TYPE_TOOL_RESULT = 3
        const val TYPE_DELIVERABLE = 4
        const val TYPE_EXECUTION = 5
    }
}

private fun VoiceToolResultView.asTimelineItem(): VoiceToolResultView = apply {
    val density = resources.displayMetrics.density
    layoutParams = RecyclerView.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT,
        ViewGroup.LayoutParams.WRAP_CONTENT,
    ).apply {
        marginStart = (16 * density).toInt()
        marginEnd = (16 * density).toInt()
        topMargin = (2 * density).toInt()
        bottomMargin = (6 * density).toInt()
    }
}
