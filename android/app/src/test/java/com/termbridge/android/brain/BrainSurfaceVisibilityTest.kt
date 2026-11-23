package com.termbridge.android.brain

import org.junit.Assert.*
import org.junit.Test

class BrainSurfaceVisibilityTest {
    @Test fun callNeverShowsTextWelcomeOrTimeline() {
        for (hasItems in listOf(false, true)) {
            val state = BrainSurfaceVisibility.resolve(callActive = true, hasItems = hasItems)
            assertTrue(state.call)
            assertFalse(state.empty)
            assertFalse(state.timeline)
        }
    }

    @Test fun hangupRestoresTheCorrectTextSurface() {
        assertEquals(BrainSurfaceVisibility(false, false, true), BrainSurfaceVisibility.resolve(false, false))
        assertEquals(BrainSurfaceVisibility(false, true, false), BrainSurfaceVisibility.resolve(false, true))
    }
}
