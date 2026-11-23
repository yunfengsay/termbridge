package com.termbridge.android.brain

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class VoiceSemanticEndpointTest {
    @Test
    fun `filtered background closes the remote semantic turn with silence before commit`() {
        val events = mutableListOf<String>()
        var tail = ByteArray(0)

        VoiceSemanticEndpoint.finishAfterFilteredBackground(
            sendAudio = {
                tail = it
                events += "audio"
            },
            commit = { events += "commit" },
        )

        assertEquals(listOf("audio", "commit"), events)
        assertTrue(tail.size >= 16_000 * 2 * 1_400 / 1_000)
        assertTrue(tail.size <= 64 * 1_024)
        assertTrue(tail.all { it == 0.toByte() })
    }
}
