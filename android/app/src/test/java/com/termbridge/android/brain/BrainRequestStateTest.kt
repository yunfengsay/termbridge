package com.termbridge.android.brain

import com.termbridge.android.protocol.BrainMessageInfo
import com.termbridge.android.protocol.BrainTaskInfo
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class BrainRequestStateTest {
    @Test
    fun `a direct cloud reply completes a pending request without a worker task`() {
        val messages = listOf(
            BrainMessageInfo("request-1", "user", "最新的一张照片", 100L),
            BrainMessageInfo("request-1-brain", "brain", "照片选择窗口已打开", 200L),
        )

        assertTrue(snapshotCompletesPendingRequest("request-1", messages, emptyList()))
    }

    @Test
    fun `an unrelated reply does not complete the pending request`() {
        val messages = listOf(BrainMessageInfo("other-brain", "brain", "旧回复", 100L))
        assertFalse(snapshotCompletesPendingRequest("request-1", messages, emptyList()))
    }

    @Test
    fun `a dispatched worker task still completes the composer wait`() {
        val tasks = listOf(
            BrainTaskInfo("task-1", "request-1", "修改代码", "codex", "dispatched", 100L, 100L),
        )
        assertTrue(snapshotCompletesPendingRequest("request-1", emptyList(), tasks))
    }
}
