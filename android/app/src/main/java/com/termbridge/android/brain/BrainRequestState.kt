package com.termbridge.android.brain

import com.termbridge.android.protocol.BrainMessageInfo
import com.termbridge.android.protocol.BrainTaskInfo

internal fun snapshotCompletesPendingRequest(
    requestId: String,
    messages: List<BrainMessageInfo>,
    tasks: List<BrainTaskInfo>,
): Boolean = tasks.any { it.requestId == requestId } ||
    messages.any { it.role == "brain" && it.id == "$requestId-brain" }
