package com.termbridge.android.brain

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class VoiceStatusCaptionStateTest {
    @Test
    fun `remote ready clears a stale offline caption`() {
        val state = VoiceStatusCaptionState()

        state.showOffline()

        assertTrue(state.clearOfflineForRemoteReady())
        assertFalse(state.clearOfflineForRemoteReady())
    }

    @Test
    fun `remote ready preserves assistant or tool content`() {
        val state = VoiceStatusCaptionState()

        state.showOffline()
        state.showContent()

        assertFalse(state.clearOfflineForRemoteReady())
    }
}
