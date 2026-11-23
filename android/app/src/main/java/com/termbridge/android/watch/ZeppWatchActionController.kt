package com.termbridge.android.watch

import com.termbridge.android.protocol.ControlMessage
import java.io.Closeable
import java.util.Locale
import java.util.UUID

enum class ZeppWatchAction(val wireName: String) {
    SUMMARIZE("summarize"),
    RETRY("retry"),
    CONTINUE("continue"),
    STOP("stop"),
    SNOOZE("snooze"),
    ;

    companion object {
        fun fromWireName(value: String): ZeppWatchAction? = entries.firstOrNull {
            it.wireName == value.lowercase(Locale.US)
        }
    }
}

data class ZeppWatchActionSnapshot(
    val id: String,
    val action: ZeppWatchAction,
    val sessionId: String,
    val state: String,
    val summary: String,
    val error: String,
    val updatedAt: Long,
) {
    val terminal: Boolean get() = state == STATE_DONE || state == STATE_ERROR

    fun toJson(): String = buildString {
        append("{\"version\":1,\"actionId\":").append(id.jsonQuoted())
        append(",\"action\":").append(action.wireName.jsonQuoted())
        append(",\"sessionId\":").append(sessionId.jsonQuoted())
        append(",\"state\":").append(state.jsonQuoted())
        append(",\"summary\":").append(summary.jsonQuoted())
        append(",\"error\":").append(error.jsonQuoted())
        append(",\"updatedAt\":").append(updatedAt.coerceAtLeast(0L)).append('}')
    }

    companion object {
        const val STATE_QUEUED = "queued"
        const val STATE_THINKING = "thinking"
        const val STATE_DONE = "done"
        const val STATE_ERROR = "error"
    }
}

/** Routes a fixed set of watch actions through the existing Global control plane. */
class ZeppWatchActionController(
    private val isHostReady: () -> Boolean,
    private val sendControl: (List<Pair<String, Any?>>) -> Boolean,
    private val onReceipt: (ZeppWatchActionSnapshot) -> Unit = {},
    private val now: () -> Long = System::currentTimeMillis,
) : Closeable {
    private val turns = linkedMapOf<String, ActionTurn>()

    @Synchronized
    fun submit(action: ZeppWatchAction, sessionId: String): ZeppWatchActionSnapshot {
        val boundedSession = sessionId.trim().take(MAX_SESSION_ID_CHARS)
        require(boundedSession.isNotEmpty() && boundedSession.none(Char::isISOControl)) { "invalid_session" }
        require(action != ZeppWatchAction.SNOOZE) { "local_action" }
        if (!isHostReady()) throw VoiceUnavailableException("global_offline")

        val id = UUID.randomUUID().toString()
        val requestId = "$id-watch-action"
        val snapshot = ZeppWatchActionSnapshot(
            id = id,
            action = action,
            sessionId = boundedSession,
            state = ZeppWatchActionSnapshot.STATE_QUEUED,
            summary = actionQueuedLabel(action),
            error = "",
            updatedAt = now(),
        )
        val turn = ActionTurn(snapshot, requestId)
        turns[id] = turn
        trimLocked()
        val sent = sendControl(
            listOf(
                "t" to "brain_send",
                "requestId" to requestId,
                "text" to actionPrompt(action),
                "clientPlatform" to "zepp-watch-action",
                "sourceSessionId" to boundedSession,
            ),
        )
        if (sent) {
            updateLocked(turn, snapshot.copy(state = ZeppWatchActionSnapshot.STATE_THINKING, updatedAt = now()))
        } else {
            failLocked(turn, "global_offline")
        }
        return turn.snapshot
    }

    @Synchronized
    fun recordLocal(action: ZeppWatchAction, sessionId: String, summary: String): ZeppWatchActionSnapshot {
        val snapshot = ZeppWatchActionSnapshot(
            id = UUID.randomUUID().toString(),
            action = action,
            sessionId = sessionId.take(MAX_SESSION_ID_CHARS),
            state = ZeppWatchActionSnapshot.STATE_DONE,
            summary = summary.take(MAX_SUMMARY_CHARS),
            error = "",
            updatedAt = now(),
        )
        turns[snapshot.id] = ActionTurn(snapshot, "")
        trimLocked()
        onReceipt(snapshot)
        return snapshot
    }

    @Synchronized
    fun snapshot(id: String): ZeppWatchActionSnapshot? {
        expireLocked()
        return turns[id]?.snapshot
    }

    @Synchronized
    fun onHostUnavailable() {
        turns.values.filter { !it.snapshot.terminal }.forEach { failLocked(it, "global_offline") }
    }

    fun handle(message: ControlMessage): Boolean {
        if (message.type == "brain_snapshot_result") {
            val messages = message.brainMessages()
            val turn = synchronized(this) {
                turns.values.lastOrNull { candidate ->
                    !candidate.snapshot.terminal && messages.any {
                        it.id == "${candidate.requestId}-brain" && it.role == "brain"
                    }
                }
            } ?: return false
            val answer = messages.last { it.id == "${turn.requestId}-brain" && it.role == "brain" }
            synchronized(this) {
                updateLocked(
                    turn,
                    turn.snapshot.copy(
                        state = ZeppWatchActionSnapshot.STATE_DONE,
                        summary = answer.text.trim().ifBlank { "操作已完成" }.take(MAX_SUMMARY_CHARS),
                        updatedAt = now(),
                    ),
                )
            }
            return true
        }
        val requestId = message.string("requestId") ?: message.brainExecutionEvent()?.requestId ?: return false
        val turn = synchronized(this) { turns.values.firstOrNull { it.requestId == requestId } } ?: return false
        return when (message.type) {
            "brain_accepted" -> true
            "brain_execution_event" -> {
                when (message.brainExecutionEvent()?.phase) {
                    "fork_failed" -> synchronized(this) { failLocked(turn, "global_failed") }
                    "fork_completed" -> sendControl(listOf("t" to "brain_snapshot"))
                }
                true
            }
            else -> false
        }
    }

    @Synchronized
    private fun updateLocked(turn: ActionTurn, snapshot: ZeppWatchActionSnapshot) {
        turn.snapshot = snapshot
        if (snapshot.terminal) onReceipt(snapshot)
    }

    @Synchronized
    private fun failLocked(turn: ActionTurn, error: String) {
        if (turn.snapshot.terminal) return
        updateLocked(
            turn,
            turn.snapshot.copy(
                state = ZeppWatchActionSnapshot.STATE_ERROR,
                error = error,
                summary = actionErrorLabel(error),
                updatedAt = now(),
            ),
        )
    }

    @Synchronized
    private fun expireLocked() {
        turns.values.filter { !it.snapshot.terminal && now() - it.snapshot.updatedAt > ACTION_TIMEOUT_MS }
            .forEach { failLocked(it, "timeout") }
    }

    private fun trimLocked() {
        while (turns.size > MAX_ACTIONS) turns.remove(turns.keys.first())
    }

    override fun close() = Unit

    private data class ActionTurn(var snapshot: ZeppWatchActionSnapshot, val requestId: String)

    companion object {
        private const val MAX_ACTIONS = 16
        private const val MAX_SESSION_ID_CHARS = 256
        private const val MAX_SUMMARY_CHARS = 320
        private const val ACTION_TIMEOUT_MS = 120_000L

        internal fun actionPrompt(action: ZeppWatchAction): String = when (action) {
            ZeppWatchAction.SUMMARIZE -> "请只总结当前来源 Agent 的真实状态、已完成工作、阻塞点和需要我决定的事项，不执行新操作。"
            ZeppWatchAction.RETRY -> "请检查当前来源 Agent 最近失败或阻塞的步骤；仅在仍然安全且条件具备时让它重试，否则说明不能重试的原因。"
            ZeppWatchAction.CONTINUE -> "请让当前来源 Agent 基于已有上下文继续下一步，并报告实际派发结果。"
            ZeppWatchAction.STOP -> "请停止当前来源 Agent 仍在运行的任务；若它已经结束，报告实际状态，不要虚报已取消。"
            ZeppWatchAction.SNOOZE -> error("Snooze is handled on the phone")
        }

        private fun actionQueuedLabel(action: ZeppWatchAction): String = when (action) {
            ZeppWatchAction.SUMMARIZE -> "正在获取摘要"
            ZeppWatchAction.RETRY -> "正在检查并重试"
            ZeppWatchAction.CONTINUE -> "正在继续任务"
            ZeppWatchAction.STOP -> "正在停止任务"
            ZeppWatchAction.SNOOZE -> "已稍后处理"
        }

        private fun actionErrorLabel(error: String): String = when (error) {
            "global_offline" -> "Global 当前离线"
            "timeout" -> "操作超时，请稍后重试"
            else -> "操作失败"
        }
    }
}
