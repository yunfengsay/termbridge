package com.termbridge.android.brain

import kotlin.math.abs
import kotlin.math.exp

internal object VoiceLevelDynamics {
    /**
     * Removes the communication-mic noise floor, then applies a soft compressor. Quiet
     * syllables become visible while normal speech still keeps headroom for emphatic peaks.
     */
    fun amplify(level: Float): Float {
        val normalized = ((level.coerceIn(0f, 1f) - INPUT_FLOOR) / INPUT_RANGE).coerceIn(0f, 1f)
        val compressed = 1f - exp(-normalized * INPUT_COMPRESSION)
        return (compressed / INPUT_COMPRESSION_MAX).coerceIn(0f, 1f)
    }

    /**
     * Combines loudness with short-term level movement so closely spaced syllables create
     * visibly quicker motion without making quiet background noise animate the voice body.
     */
    fun rhythmTarget(previous: Float, current: Float): Float {
        val level = current.coerceIn(0f, 1f)
        val transient = abs(level - previous.coerceIn(0f, 1f))
        return (level * RHYTHM_LEVEL_WEIGHT + transient * RHYTHM_TRANSIENT_GAIN).coerceIn(0f, 1f)
    }

    fun filterInput(current: Float, target: Float): Float {
        val delta = target - current
        if (abs(delta) < INPUT_DEADBAND) return current
        return current + delta * if (delta > 0f) INPUT_ATTACK else INPUT_RELEASE
    }

    fun animate(current: Float, target: Float, elapsedMs: Float): Float {
        val timeConstant = if (target > current) ATTACK_MS else RELEASE_MS
        val progress = 1f - exp(-elapsedMs.coerceAtLeast(1f) / timeConstant)
        val next = current + (target - current) * progress
        return if (abs(target - next) < SETTLE_EPSILON) target else next
    }

    fun animateRhythm(current: Float, target: Float, elapsedMs: Float): Float {
        val timeConstant = if (target > current) RHYTHM_ATTACK_MS else RHYTHM_RELEASE_MS
        val progress = 1f - exp(-elapsedMs.coerceAtLeast(1f) / timeConstant)
        return current + (target - current) * progress
    }

    fun phaseAdvance(elapsedMs: Float, baseSpeed: Float, energy: Float, rhythm: Float): Float {
        val audioMultiplier = 1f + energy.coerceIn(0f, 1f) * ENERGY_SPEED_GAIN +
            rhythm.coerceIn(0f, 1f) * RHYTHM_SPEED_GAIN
        return elapsedMs.coerceIn(1f, MAX_FRAME_MS) / 1_000f * baseSpeed * audioMultiplier
    }

    const val FRAME_MS = 16f
    const val MAX_FRAME_MS = 50f
    private const val INPUT_FLOOR = 0.012f
    private const val INPUT_RANGE = 0.23f
    private const val INPUT_COMPRESSION = 2.1f
    private val INPUT_COMPRESSION_MAX = 1f - exp(-INPUT_COMPRESSION)
    private const val INPUT_DEADBAND = 0.007f
    private const val INPUT_ATTACK = 0.78f
    private const val INPUT_RELEASE = 0.24f
    private const val RHYTHM_LEVEL_WEIGHT = 0.46f
    private const val RHYTHM_TRANSIENT_GAIN = 4.1f
    private const val ATTACK_MS = 42f
    private const val RELEASE_MS = 190f
    private const val RHYTHM_ATTACK_MS = 30f
    private const val RHYTHM_RELEASE_MS = 165f
    private const val ENERGY_SPEED_GAIN = 1.12f
    private const val RHYTHM_SPEED_GAIN = 2.15f
    private const val SETTLE_EPSILON = 0.002f
}
