package com.termbridge.android.brain

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class VoiceToolCueTest {
    @Test
    fun notificationHasExpectedDurationAndAudibleEnvelope() {
        val pcm = VoiceToolCue.generateNotificationPcm()
        assertEquals(
            VoiceToolCue.SAMPLE_RATE * VoiceToolCue.NOTIFICATION_DURATION_MS / 1_000,
            pcm.size,
        )
        assertTrue(pcm.any { it != 0.toShort() })
        assertTrue(pcm.maxOf { kotlin.math.abs(it.toInt()) } < Short.MAX_VALUE)
        assertTrue(kotlin.math.abs(pcm.last().toInt()) < 1_000)
    }

    @Test
    fun activityCueIsContinuousBoundedAndVariesOverTime() {
        val pcm = VoiceToolCue.generateActivityPcm()
        assertEquals(
            VoiceToolCue.SAMPLE_RATE * VoiceToolCue.ACTIVITY_DURATION_MS / 1_000,
            pcm.size,
        )
        val peak = pcm.maxOf { kotlin.math.abs(it.toInt()) }
        assertTrue(peak in 500 until 8_000)
        assertTrue(kotlin.math.abs(pcm.first().toInt() - pcm.last().toInt()) < 700)
        val window = VoiceToolCue.SAMPLE_RATE / 5
        val levels = pcm.asSequence().chunked(window).map { chunk ->
            chunk.sumOf { kotlin.math.abs(it.toInt()).toLong() } / chunk.size
        }.toList()
        assertTrue((levels.maxOrNull() ?: 0) > (levels.minOrNull() ?: 0) * 13 / 10)
    }
}
