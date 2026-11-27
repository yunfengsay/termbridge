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

    @Test fun `pre-roll and hangover silence are kept for ASR but excluded from speaker scoring`() {
        val measuredFrames = mutableListOf<List<Short>>()
        val gate = StreamingSpeakerGate(windowFrames = 4) { frames ->
            measuredFrames += frames.map { it.single() }
            0.85f
        }
        // 2 pre-roll silence frames (speech=true, voicedForSpeaker=false) + 2 voiced frames
        assertTrue(gate.accept(shortArrayOf(10), speech = true, voicedForSpeaker = false).audio.isEmpty())
        assertTrue(gate.accept(shortArrayOf(11), speech = true, voicedForSpeaker = false).audio.isEmpty())
        assertTrue(gate.accept(shortArrayOf(12), speech = true, voicedForSpeaker = true).audio.isEmpty())
        val first = gate.accept(shortArrayOf(13), speech = true, voicedForSpeaker = true)
        assertTrue(first.authorized)
        // Full audio (including pre-roll) is released to ASR, while CAM++ only scored the 2 voiced frames.
        assertEquals(listOf<Short>(10, 11, 12, 13), first.audio.map { it.single() })
        assertEquals(listOf(listOf<Short>(12, 13)), measuredFrames)

        // Pure hangover silence tail after authorized utterance drains cleanly without spurious rejection.
        gate.accept(shortArrayOf(14), speech = true, voicedForSpeaker = false)
        val tail = gate.accept(shortArrayOf(0), speech = false, voicedForSpeaker = false)
        assertFalse(tail.rejected)
        assertEquals(listOf<Short>(14), tail.audio.map { it.single() })
        assertEquals(1, measuredFrames.size)
    }

    @Test fun `falls back to raw pre-denoiser frames when denoised audio distorts owner voiceprint`() {
        val gate = StreamingSpeakerGate(windowFrames = 2) { frames ->
            // Denoised frames carry value 1 (low score); raw frames carry value 9 (owner match).
            if (frames.first().single() == 9.toShort()) 0.72f else 0.18f
        }
        gate.accept(shortArrayOf(1), speech = true, voicedForSpeaker = true, rawFrame = shortArrayOf(9))
        val result = gate.accept(shortArrayOf(1), speech = true, voicedForSpeaker = true, rawFrame = shortArrayOf(9))
        assertTrue(result.authorized)
        assertFalse(result.rejected)
        // Outgoing audio stays denoised while verification succeeded via raw acoustic domain.
        assertEquals(listOf<Short>(1, 1), result.audio.map { it.single() })
        assertEquals(0.72f, result.score!!, 0.001f)
    }
}
