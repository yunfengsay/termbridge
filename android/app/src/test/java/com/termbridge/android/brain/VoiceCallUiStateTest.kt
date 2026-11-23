package com.termbridge.android.brain

import org.junit.Assert.*
import org.junit.Test

class VoiceCallUiStateTest {
    @Test fun `background transition invalidates stale activity surface claims`() {
        val stalePage = Any()
        VoiceAppVisibility.setForeground(true)
        VoiceCallUiState.setSurfaceVisible(stalePage, true)
        VoiceAppVisibility.setForeground(false)
        try {
            assertFalse("An old Activity flag must not hide the desktop orb", VoiceCallUiState.current().surfaceVisible)
        } finally { VoiceCallUiState.setSurfaceVisible(stalePage, false) }
    }
    @Test fun `surface handoff keeps the mini orb visible but unrelated pages do not count`() {
        val callPage = Any()
        val terminal = Any()
        VoiceCallUiState.setSurfaceVisible(callPage, true)
        VoiceCallUiState.setSurfaceVisible(terminal, true)
        VoiceCallUiState.setSurfaceVisible(callPage, false)
        assertTrue(VoiceCallUiState.current().surfaceVisible)
        VoiceCallUiState.setSurfaceVisible(terminal, false)
        assertFalse(VoiceCallUiState.current().surfaceVisible)
        assertFalse(VoiceCallUiState.current().overlayVisible)
    }
}
