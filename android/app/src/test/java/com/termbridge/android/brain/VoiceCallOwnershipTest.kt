package com.termbridge.android.brain

import org.junit.Assert.*
import org.junit.Test

class VoiceCallOwnershipTest {
    @Test fun `second screen releases the old microphone before taking ownership`() {
        val calls = VoiceCallOwnership()
        val first = Any()
        val second = Any()
        var microphones = 1
        calls.acquire(first) { microphones--; calls.release(first) }
        calls.acquire(second) { microphones--; calls.release(second) }
        assertEquals(0, microphones)
        microphones++
        assertFalse(calls.release(first)) // delayed onDestroy cannot end the new call
        assertTrue(calls.owns(second))
        calls.stopActive("overlay_hangup")
        assertEquals(0, microphones)
        assertFalse(calls.owns(second))
    }

    @Test fun `reopening the same call neither duplicates nor stops it`() {
        val calls = VoiceCallOwnership()
        val owner = Any()
        var stops = 0
        calls.acquire(owner) { stops++; calls.release(owner) }
        calls.acquire(owner) { fail("must preserve original cleanup callback") }
        assertEquals(0, stops)
        calls.stopActive("overlay_unavailable")
        calls.stopActive("overlay_unavailable")
        assertEquals(1, stops)
    }
}
