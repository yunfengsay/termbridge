package com.termbridge.android.brain

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class VoiceNoiseGateTest {
    @Test
    fun `conservative gate ignores isolated neural vad spikes`() {
        val gate = VoiceNoiseGate(VoiceNoiseSensitivity.CONSERVATIVE)
        repeat(16) { gate.observe(0.04f) }

        val decisions = listOf(0.75f, 0.82f, 0.18f, 0.77f, 0.08f).map(gate::observe)

        assertTrue(decisions.none { it.opened || it.audible })
    }

    @Test
    fun `conservative gate opens only after sustained model speech confidence`() {
        val gate = VoiceNoiseGate(VoiceNoiseSensitivity.CONSERVATIVE)
        repeat(16) { gate.observe(0.03f) }

        val decisions = List(12) { gate.observe(0.92f) }

        assertTrue(decisions.any { it.opened })
        assertTrue(decisions.last().audible)
    }

    @Test
    fun `dual threshold hangover prevents choppy close then eventually closes`() {
        val gate = VoiceNoiseGate(VoiceNoiseSensitivity.CONSERVATIVE)
        repeat(16) { gate.observe(0.03f) }
        repeat(12) { gate.observe(0.92f) }

        repeat(8) { assertTrue(gate.observe(0.05f).audible) }
        val tail = List(24) { gate.observe(0.05f) }

        assertTrue(tail.any { it.closed })
        assertFalse(tail.last().audible)
    }

    @Test
    fun `conservative mode needs more evidence than sensitive mode`() {
        val conservative = VoiceNoiseGate(VoiceNoiseSensitivity.CONSERVATIVE)
        val sensitive = VoiceNoiseGate(VoiceNoiseSensitivity.SENSITIVE)
        repeat(16) {
            conservative.observe(0.04f)
            sensitive.observe(0.04f)
        }

        val conservativeDecision = List(5) { conservative.observe(0.55f) }.last()
        val sensitiveDecision = List(5) { sensitive.observe(0.55f) }.last()

        assertFalse(conservativeDecision.audible)
        assertTrue(sensitiveDecision.audible)
    }

    @Test
    fun `conservative gate learns a raised wind noise floor before admitting speech`() {
        val gate = VoiceNoiseGate(VoiceNoiseSensitivity.CONSERVATIVE)

        val windDecisions = List(80) { index ->
            gate.observe(0.16f + (index % 5) * 0.015f)
        }

        assertTrue(windDecisions.none { it.opened || it.audible })
        val speechDecisions = List(12) { gate.observe(0.94f) }
        assertTrue(speechDecisions.any { it.opened })
        assertTrue(speechDecisions.last().audible)
    }
}
