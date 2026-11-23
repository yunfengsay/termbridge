package com.termbridge.android.ui

import org.junit.Assert.assertEquals
import org.junit.Test

class ScrollActionProgressTest {
    @Test fun scrollDownGraduallyHidesAndReverseRestores() {
        val state = ScrollActionProgress(100f)
        assertEquals(0.75f, state.scroll(25, false), 0.001f)
        assertEquals(0.25f, state.scroll(50, false), 0.001f)
        assertEquals(0f, state.scroll(1000, false), 0.001f)
        assertEquals(0.2f, state.scroll(-20, false), 0.001f)
        assertEquals(1f, state.scroll(-1000, false), 0.001f)
    }

    @Test fun topAndShortListsAlwaysExposeCreate() {
        val state = ScrollActionProgress(100f)
        state.scroll(100, false)
        assertEquals(1f, state.scroll(0, true), 0f)
        assertEquals(1f, state.scroll(40, true), 0f)
    }

    @Test fun tinyBackAndForthDoesNotToggleTheWholeButton() {
        val state = ScrollActionProgress(100f)
        repeat(50) { state.scroll(1, false); state.scroll(-1, false) }
        assertEquals(1f, state.visibleFraction, 0.001f)
    }
}
