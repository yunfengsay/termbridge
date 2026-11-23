package com.termbridge.android.brain

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class VoiceProfileCodecTest {
    @Test
    fun `round trips speaker embedding without text serialization`() {
        val embedding = floatArrayOf(0.25f, -0.5f, 0.75f)
        assertArrayEquals(embedding, VoiceProfileCodec.decode(VoiceProfileCodec.encode(embedding)), 0f)
    }

    @Test
    fun `rejects malformed profile data`() {
        assertThrows(IllegalArgumentException::class.java) {
            VoiceProfileCodec.decode(byteArrayOf(1, 2, 3))
        }
    }
}
