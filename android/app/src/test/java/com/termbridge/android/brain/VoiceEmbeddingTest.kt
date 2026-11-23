package com.termbridge.android.brain

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class VoiceEmbeddingTest {
    @Test
    fun `averages normalized enrollment samples`() {
        val profile = VoiceEmbedding.average(listOf(floatArrayOf(2f, 0f), floatArrayOf(1f, 0f)))
        assertEquals(1f, profile[0], 0.0001f)
        assertEquals(0f, profile[1], 0.0001f)
    }

    @Test
    fun `compares direction rather than recording volume`() {
        assertTrue(VoiceEmbedding.similarity(floatArrayOf(1f, 2f), floatArrayOf(4f, 8f)) > 0.999f)
        assertTrue(VoiceEmbedding.similarity(floatArrayOf(1f, 0f), floatArrayOf(0f, 1f)) < 0.01f)
    }
}
