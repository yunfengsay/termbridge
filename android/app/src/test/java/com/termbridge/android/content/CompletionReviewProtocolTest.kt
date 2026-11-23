package com.termbridge.android.content

import com.termbridge.android.protocol.CompletionReviewProtocol
import org.junit.Assert.*
import org.junit.Test

class CompletionReviewProtocolTest {
    @Test fun approvalRequiresExactBoundedCompletionId() {
        val id = "completion-" + "a".repeat(32)
        assertEquals(id, CompletionReviewProtocol.approvalId("$id:handoff"))
        assertNull(CompletionReviewProtocol.approvalId(id))
        assertNull(CompletionReviewProtocol.approvalId("herdr:agent:handoff"))
        assertNull(CompletionReviewProtocol.approvalId("completion-evil:handoff"))
    }
}
