package com.termbridge.android.brain

import org.junit.Assert.assertEquals
import org.junit.Test

class TargetSpeakerTrackerTest {
    @Test
    fun `locks the enrolled speaker then ends after repeated other-speaker windows`() {
        val tracker = TargetSpeakerTracker()

        assertEquals(TargetSpeakerDecision.WAITING, tracker.observe(0.29f))
        assertEquals(TargetSpeakerDecision.AUTHORIZED, tracker.observe(0.31f))
        assertEquals(TargetSpeakerDecision.ACCEPTED, tracker.observe(0.28f))
        assertEquals(TargetSpeakerDecision.HOLD, tracker.observe(0.24f))
        assertEquals(TargetSpeakerDecision.TARGET_ENDED, tracker.observe(0.23f))
    }

    @Test
    fun `one noisy window does not cut off the target speaker`() {
        val tracker = TargetSpeakerTracker()

        assertEquals(TargetSpeakerDecision.AUTHORIZED, tracker.observe(0.61f))
        assertEquals(TargetSpeakerDecision.HOLD, tracker.observe(null))
        assertEquals(TargetSpeakerDecision.ACCEPTED, tracker.observe(0.46f))
        assertEquals(TargetSpeakerDecision.HOLD, tracker.observe(0.20f))
    }

    @Test
    fun `reset requires the next turn to authenticate again`() {
        val tracker = TargetSpeakerTracker()

        assertEquals(TargetSpeakerDecision.AUTHORIZED, tracker.observe(0.70f))
        tracker.reset()

        assertEquals(TargetSpeakerDecision.WAITING, tracker.observe(0.29f))
        assertEquals(TargetSpeakerDecision.AUTHORIZED, tracker.observe(0.30f))
    }
}
