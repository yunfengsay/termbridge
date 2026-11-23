package com.termbridge.android.brain

import kotlin.math.sin

/** Pure ring deformation math kept separate from Canvas rendering for deterministic tests. */
internal object VoiceRingDynamics {
    fun radialOffset(
        angle: Float,
        ringIndex: Int,
        seconds: Float,
        energy: Float,
        speed: Float,
    ): Float {
        val phase = ringIndex * 0.91f
        val harmonic =
            sin(angle * (3 + ringIndex % 3) + seconds * speed * 1.8f + phase) * 0.52f +
                sin(angle * (6 + ringIndex % 2) - seconds * speed * 1.25f + phase * 1.7f) * 0.30f +
                sin(angle * (10 + ringIndex % 4) + seconds * speed * 0.72f - phase * 0.6f) * 0.18f
        return harmonic * deformationAmplitude(energy)
    }

    fun deformationAmplitude(energy: Float): Float =
        IDLE_DEFORMATION + energy.coerceIn(0f, 1f) * AUDIO_DEFORMATION

    private const val IDLE_DEFORMATION = 0.018f
    private const val AUDIO_DEFORMATION = 0.18f
}
