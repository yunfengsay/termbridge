package com.termbridge.android.brain

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Test

class OnDeviceVoiceModelsTest {
    @Test
    fun `denoised pcm is clipped and framed for the realtime uplink`() {
        val frameSize = 4
        val stream = StreamingDenoisedFrames(frameSize)
        val frames = stream.append(floatArrayOf(-2f, -1f, -0.5f, 0f, 0.5f, 0.999f, 1f)) + stream.finish()

        assertEquals(2, frames.size)
        assertArrayEquals(shortArrayOf(Short.MIN_VALUE, Short.MIN_VALUE, -16384, 0), frames[0])
        assertArrayEquals(shortArrayOf(16384, 32735, Short.MAX_VALUE, 0), frames[1])
    }
}
