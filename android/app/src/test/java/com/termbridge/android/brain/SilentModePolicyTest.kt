package com.termbridge.android.brain

import com.termbridge.android.protocol.BrainModelTier
import com.termbridge.android.protocol.ExecutionForkEventInfo
import org.junit.Assert.*
import org.junit.Test

class SilentModePolicyTest {
    private fun event(id: String, phase: String, workflow: String? = "silent", time: Long = 1) =
        ExecutionForkEventInfo("$id:$phase", "fork-$id", id, phase, time, workflow = workflow)

    @Test fun `reconnect restores silent progress and all terminal states clear it`() {
        for (terminal in SilentModePolicy.terminalPhases) {
            val started = listOf(event("a", "fork_started"), event("voice", "fork_started", "standard"))
            assertEquals("a", SilentModePolicy.activeRequest(started))
            assertNull(SilentModePolicy.activeRequest(started + event("a", terminal)))
        }
    }

    @Test fun `latest active job remains cancellable after another finishes`() {
        val events = listOf(event("a", "fork_started"), event("b", "fork_started", time = 2))
        assertEquals("b", SilentModePolicy.activeRequest(events))
        assertEquals("a", SilentModePolicy.activeRequest(events + event("b", "fork_cancelled")))
    }

    @Test fun `screen protection follows foreground work without keeping idle or background awake`() {
        assertTrue(SilentModePolicy.keepAwake(true, true, false, true))
        assertTrue(SilentModePolicy.keepAwake(true, true, true, false))
        assertFalse(SilentModePolicy.keepAwake(true, false, false, true))
        assertFalse(SilentModePolicy.keepAwake(false, true, false, true))
        assertFalse(SilentModePolicy.keepAwake(true, true, false, false))
    }

    @Test fun `unknown model tier uses the safe advanced default`() {
        assertEquals(BrainModelTier.ADVANCED, BrainModelTier.from("untrusted-model"))
        assertEquals(BrainModelTier.DEEP, BrainModelTier.from("deep"))
    }
}
