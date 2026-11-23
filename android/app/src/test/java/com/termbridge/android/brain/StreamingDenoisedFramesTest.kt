package com.termbridge.android.brain

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Test

class StreamingDenoisedFramesTest {
    @Test fun `startup latency never inserts raw samples or duplicates delayed output`() {
        val stream = StreamingDenoisedFrames(4)
        assertEquals(0, stream.append(floatArrayOf(.1f, .2f)).size)
        val frames = stream.append(floatArrayOf(.3f, .4f, .5f, .6f))
        assertEquals(1, frames.size)
        assertArrayEquals(shortArrayOf(3276, 6553, 9830, 13107), frames[0])
        assertArrayEquals(shortArrayOf(16384, 19660, 22937, 26214), stream.append(floatArrayOf(.7f, .8f))[0])
        assertEquals(0, stream.finish().size)
    }

    @Test fun `capture completion pads only its last partial frame and reset discards old audio`() {
        val stream = StreamingDenoisedFrames(4)
        stream.append(floatArrayOf(.5f))
        assertArrayEquals(shortArrayOf(16384, 0, 0, 0), stream.finish()[0])
        assertEquals(0, stream.finish().size)
        stream.append(floatArrayOf(.5f))
        stream.reset()
        assertArrayEquals(shortArrayOf(0, 0, 0, 0), stream.append(FloatArray(4))[0])
    }

    @Test fun `different inference output chunk sizes preserve identical pcm`() {
        val input = FloatArray(51) { (it - 25) / 30f }
        fun replay(size: Int): List<Short> {
            val stream = StreamingDenoisedFrames(4)
            val frames = input.toList().chunked(size).flatMap { stream.append(it.toFloatArray()) } + stream.finish()
            return frames.flatMap { it.toList() }
        }
        assertEquals(replay(51), replay(3))
        assertEquals(replay(51), replay(8))
    }
}
