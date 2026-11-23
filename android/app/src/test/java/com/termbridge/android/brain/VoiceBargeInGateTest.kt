package com.termbridge.android.brain

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class VoiceBargeInGateTest {
    @Test
    fun `potential speech mutes playback before speaker verification completes`() {
        val gate = VoiceBargeInGate()
        gate.onResponseStarted()

        assertTrue(gate.onPotentialSpeechStarted(assistantResponding = true))
        assertFalse(gate.onPotentialSpeechStarted(assistantResponding = true))
        assertTrue(gate.onAuthorizedSpeechStarted(assistantResponding = true))
        assertFalse(gate.onPotentialSpeechTimedOut())
    }

    @Test
    fun `rejected potential speech can resume and rearm`() {
        val gate = VoiceBargeInGate()
        gate.onResponseStarted()

        assertTrue(gate.onPotentialSpeechStarted(assistantResponding = true))
        assertTrue(gate.onPotentialSpeechRejected())
        assertTrue(gate.onPotentialSpeechStarted(assistantResponding = true))
    }

    @Test
    fun `unverified ambient speech times out and restores playback`() {
        val gate = VoiceBargeInGate()
        gate.onResponseStarted()

        assertTrue(gate.onPotentialSpeechStarted(assistantResponding = true))
        assertTrue(gate.onPotentialSpeechTimedOut())
        assertFalse(gate.onPotentialSpeechTimedOut())
        assertTrue(gate.onPotentialSpeechStarted(assistantResponding = true))
    }

    @Test
    fun `speech onset interrupts one active response immediately`() {
        val gate = VoiceBargeInGate()

        assertFalse(gate.onSpeechStarted(assistantResponding = false))
        gate.onResponseStarted()
        assertTrue(gate.onSpeechStarted(assistantResponding = true))
        assertFalse(gate.onSpeechStarted(assistantResponding = true))

        gate.onResponseStarted()
        assertTrue(gate.onSpeechStarted(assistantResponding = true))
    }

    @Test
    fun `returning to listening clears a pending interruption`() {
        val gate = VoiceBargeInGate()
        gate.onResponseStarted()
        assertTrue(gate.onSpeechStarted(assistantResponding = true))

        gate.onListening()
        assertFalse(gate.onSpeechStarted(assistantResponding = false))
    }

    @Test
    fun `speech interrupts buffered local playback after remote response finished`() {
        val gate = VoiceBargeInGate()
        gate.onResponseStarted()
        gate.onListening()

        assertTrue(
            gate.onSpeechStarted(
                assistantResponding = false,
                localPlaybackActive = true,
            ),
        )
    }
}
