package com.termbridge.android.brain

import kotlin.math.ceil

enum class VoiceNoiseSensitivity(val value: String) {
    CONSERVATIVE("conservative"),
    BALANCED("balanced"),
    SENSITIVE("sensitive");

    companion object {
        fun from(value: String?): VoiceNoiseSensitivity = entries.firstOrNull { it.value == value }
            ?: CONSERVATIVE
    }
}

internal data class VoiceNoiseGateDecision(
    val audible: Boolean,
    val opened: Boolean,
    val closed: Boolean,
    val probability: Float,
    val openThreshold: Float,
    val closeThreshold: Float,
    val noiseFloor: Float,
)

/**
 * Adds the smoothing, adaptive floor, dual thresholds and hangover that a raw
 * frame-level neural VAD probability does not provide by itself.
 */
internal class VoiceNoiseGate(
    private val sensitivity: VoiceNoiseSensitivity,
) {
    private val parameters = Parameters.forSensitivity(sensitivity)
    private val probabilityWindow = FloatArray(MOVING_AVERAGE_FRAMES)
    private val floorWindow = FloatArray(NOISE_FLOOR_FRAMES)
    private var probabilityCount = 0
    private var floorCount = 0
    private var floorIndex = 0
    private var noiseFloor = INITIAL_NOISE_FLOOR
    private var active = false
    private var onsetFrames = 0
    private var silenceFrames = 0

    fun observe(rawProbability: Float): VoiceNoiseGateDecision {
        val probability = rawProbability.coerceIn(0f, 1f)
        probabilityWindow[probabilityCount % probabilityWindow.size] = probability
        probabilityCount += 1
        val smoothed = probabilityWindow
            .take(minOf(probabilityCount, probabilityWindow.size))
            .average()
            .toFloat()

        if (!active) updateNoiseFloor(smoothed)
        val openThreshold = (noiseFloor * parameters.noiseRatio)
            .coerceIn(parameters.minimumOpenThreshold, parameters.maximumOpenThreshold)
        val closeThreshold = maxOf(MINIMUM_CLOSE_THRESHOLD, openThreshold * CLOSE_THRESHOLD_RATIO)

        var opened = false
        var closed = false
        if (!active) {
            val warmedUp = floorCount >= WARMUP_FRAMES
            onsetFrames = if (warmedUp && smoothed >= openThreshold) onsetFrames + 1 else 0
            if (onsetFrames >= parameters.onsetFrames) {
                active = true
                opened = true
                onsetFrames = 0
                silenceFrames = 0
            }
        } else {
            silenceFrames = if (smoothed < closeThreshold) silenceFrames + 1 else 0
            if (silenceFrames >= parameters.hangoverFrames) {
                active = false
                closed = true
                silenceFrames = 0
                onsetFrames = 0
            }
        }

        return VoiceNoiseGateDecision(
            audible = active,
            opened = opened,
            closed = closed,
            probability = smoothed,
            openThreshold = openThreshold,
            closeThreshold = closeThreshold,
            noiseFloor = noiseFloor,
        )
    }

    private fun updateNoiseFloor(probability: Float) {
        floorWindow[floorIndex] = probability
        floorIndex = (floorIndex + 1) % floorWindow.size
        floorCount = minOf(floorCount + 1, floorWindow.size)
        val sorted = floorWindow.take(floorCount).sorted()
        val percentileIndex = (ceil(sorted.size * NOISE_FLOOR_PERCENTILE).toInt() - 1)
            .coerceIn(0, sorted.lastIndex)
        val observedFloor = sorted[percentileIndex]
        val alpha = if (observedFloor > noiseFloor) FLOOR_RISE_ALPHA else FLOOR_FALL_ALPHA
        noiseFloor = (noiseFloor * (1f - alpha) + observedFloor * alpha)
            .coerceIn(MINIMUM_NOISE_FLOOR, MAXIMUM_NOISE_FLOOR)
    }

    private data class Parameters(
        val noiseRatio: Float,
        val minimumOpenThreshold: Float,
        val maximumOpenThreshold: Float,
        val onsetFrames: Int,
        val hangoverFrames: Int,
    ) {
        companion object {
            fun forSensitivity(sensitivity: VoiceNoiseSensitivity): Parameters = when (sensitivity) {
                VoiceNoiseSensitivity.CONSERVATIVE -> Parameters(3.4f, 0.36f, 0.82f, 8, 18)
                VoiceNoiseSensitivity.BALANCED -> Parameters(2.8f, 0.28f, 0.78f, 6, 15)
                VoiceNoiseSensitivity.SENSITIVE -> Parameters(2.2f, 0.20f, 0.72f, 4, 12)
            }
        }
    }

    companion object {
        private const val MOVING_AVERAGE_FRAMES = 3
        private const val NOISE_FLOOR_FRAMES = 64
        private const val WARMUP_FRAMES = 12
        private const val NOISE_FLOOR_PERCENTILE = 0.20f
        private const val INITIAL_NOISE_FLOOR = 0.06f
        private const val MINIMUM_NOISE_FLOOR = 0.01f
        private const val MAXIMUM_NOISE_FLOOR = 0.50f
        private const val FLOOR_RISE_ALPHA = 0.20f
        private const val FLOOR_FALL_ALPHA = 0.05f
        private const val CLOSE_THRESHOLD_RATIO = 0.62f
        private const val MINIMUM_CLOSE_THRESHOLD = 0.10f
    }
}
