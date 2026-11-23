package com.termbridge.android.brain

import org.junit.Assert.*
import org.junit.Test

class StreamingSpeakerGateTest {
    @Test fun `holds audio until identity matches and releases onset once`() {
        val gate = StreamingSpeakerGate(windowFrames = 4, measure = { 0.9f })
        repeat(3) { assertTrue(gate.accept(shortArrayOf(it.toShort()), true).audio.isEmpty()) }
        val result = gate.accept(shortArrayOf(3), true)
        assertEquals(listOf<Short>(0, 1, 2, 3), result.audio.map { it.single() })
        assertTrue(result.authorized)
        assertTrue(gate.accept(shortArrayOf(4), true).audio.isEmpty())
    }

    @Test fun `television after owner is rechecked not grandfathered into the turn`() {
        var score = 0.9f
        val gate = StreamingSpeakerGate(windowFrames = 4, measure = { score })
        repeat(4) { gate.accept(shortArrayOf(1), true) }
        score = 0.1f
        repeat(3) { assertTrue(gate.accept(shortArrayOf(2), true).audio.isEmpty()) }
        val result = gate.accept(shortArrayOf(2), true)
        assertTrue(result.audio.isEmpty())
        assertFalse(result.authorized)
        assertTrue(result.rejected)
    }

    @Test fun `missing embedding fails explicitly instead of waiting forever or opening gate`() {
        val gate = StreamingSpeakerGate(windowFrames = 4, measure = { null })
        repeat(12) {
            val result = gate.accept(shortArrayOf(1), true)
            assertTrue(result.audio.isEmpty())
            assertEquals(it == 11, result.unavailable)
        }
    }

    @Test fun `silence flushes a short matching tail and resets identity`() {
        val gate = StreamingSpeakerGate(windowFrames = 4, measure = { 0.9f })
        gate.accept(shortArrayOf(7), true)
        val result = gate.accept(shortArrayOf(0), false)
        assertEquals(7.toShort(), result.audio.single().single())
        assertTrue(gate.accept(shortArrayOf(8), true).audio.isEmpty())
        gate.reset()
        assertTrue(gate.accept(shortArrayOf(0), false).audio.isEmpty())
    }
}
