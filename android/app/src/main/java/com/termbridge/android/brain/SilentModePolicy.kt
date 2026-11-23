package com.termbridge.android.brain

import com.termbridge.android.protocol.ExecutionForkEventInfo

/** Reconstruct outstanding jobs after rotation/reconnect, without reopening audio. */
object SilentModePolicy {
    val terminalPhases = setOf("fork_completed", "fork_failed", "fork_cancelled")

    fun activeRequest(events: List<ExecutionForkEventInfo>): String? = events
        .groupBy { it.requestId }.values
        .filter { steps -> steps.any { it.workflow == "silent" } && steps.none { it.phase in terminalPhases } }
        .maxByOrNull { steps -> steps.maxOf { it.createdAt } }?.firstOrNull()?.requestId

    fun keepAwake(setting: Boolean, foreground: Boolean, callActive: Boolean, silentPending: Boolean): Boolean =
        setting && foreground && (callActive || silentPending)
}
