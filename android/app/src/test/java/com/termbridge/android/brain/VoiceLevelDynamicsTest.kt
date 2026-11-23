package com.termbridge.android.brain

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class VoiceLevelDynamicsTest {
    @Test
    fun `suppresses the mic floor and expands normal speech`() {
        assertEquals(0f, VoiceLevelDynamics.amplify(0.008f), 0.0001f)
        assertTrue(VoiceLevelDynamics.amplify(0.04f) > 0.25f)
        assertTrue(VoiceLevelDynamics.amplify(0.1f) > 0.60f)
        assertEquals(1f, VoiceLevelDynamics.amplify(0.8f), 0.0001f)
    }

    @Test
    fun `deadband removes small input jitter`() {
        assertEquals(0.2f, VoiceLevelDynamics.filterInput(0.2f, 0.205f), 0.0001f)
    }

    @Test
    fun `attack responds faster than release`() {
        val rise = VoiceLevelDynamics.animate(0f, 1f, 16f)
        val fall = 1f - VoiceLevelDynamics.animate(1f, 0f, 16f)
        assertTrue(rise > fall)
    }

    @Test
    fun `closely changing speech level creates more rhythm than a steady level`() {
        val steady = VoiceLevelDynamics.rhythmTarget(0.42f, 0.44f)
        val syllable = VoiceLevelDynamics.rhythmTarget(0.12f, 0.62f)

        assertTrue(syllable > steady)
    }

    @Test
    fun `voice energy and rhythm both accelerate continuous phase`() {
        val idle = VoiceLevelDynamics.phaseAdvance(16f, 1f, 0f, 0f)
        val loud = VoiceLevelDynamics.phaseAdvance(16f, 1f, 0.8f, 0f)
        val quickSpeech = VoiceLevelDynamics.phaseAdvance(16f, 1f, 0.8f, 0.8f)

        assertTrue(loud > idle)
        assertTrue(quickSpeech > loud)
    }
}
