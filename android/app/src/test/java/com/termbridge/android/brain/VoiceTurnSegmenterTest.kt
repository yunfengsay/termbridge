package com.termbridge.android.brain

import org.junit.Assert.assertEquals
import org.junit.Test

class VoiceTurnSegmenterTest {
    @Test
    fun `keeps one turn across natural sentence pauses`() {
        val segmenter = VoiceTurnSegmenter()

        assertEquals(VoiceTurnEvent.NONE, segmenter.observe(0.8f))
        assertEquals(VoiceTurnEvent.NONE, segmenter.observe(0.8f))
        assertEquals(VoiceTurnEvent.STARTED, segmenter.observe(0.8f))

        // A speaker thinking mid-sentence often pauses for well over one second.
        // Do not turn that hesitation into a remote model response.
        repeat(45) {
            assertEquals(VoiceTurnEvent.ACTIVE, segmenter.observe(0.1f))
        }
        assertEquals(VoiceTurnEvent.ACTIVE, segmenter.observe(0.8f))

        repeat(VoiceTurnSegmenter.TRAILING_SILENCE_FRAMES - 1) {
            assertEquals(VoiceTurnEvent.ACTIVE, segmenter.observe(0.1f))
        }
        assertEquals(VoiceTurnEvent.ENDED, segmenter.observe(0.1f))
    }

    @Test
    fun `requires a fresh speech onset after a committed turn`() {
        val segmenter = VoiceTurnSegmenter()

        repeat(VoiceTurnSegmenter.START_FRAMES - 1) {
            assertEquals(VoiceTurnEvent.NONE, segmenter.observe(0.8f))
        }
        assertEquals(VoiceTurnEvent.STARTED, segmenter.observe(0.8f))
        repeat(VoiceTurnSegmenter.TRAILING_SILENCE_FRAMES - 1) {
            assertEquals(VoiceTurnEvent.ACTIVE, segmenter.observe(0.1f))
        }
        assertEquals(VoiceTurnEvent.ENDED, segmenter.observe(0.1f))
        assertEquals(VoiceTurnEvent.NONE, segmenter.observe(0.1f))
    }
}
