package com.termbridge.android.brain

internal enum class VoiceTurnEvent {
    NONE,
    STARTED,
    ACTIVE,
    ENDED,
}

/**
 * Turns noisy frame-level VAD probabilities into stable conversational turns.
 * A natural sentence pause must not become a remote commit; only sustained
 * silence ends the turn.
 */
internal class VoiceTurnSegmenter(
    private val startProbability: Float = START_PROBABILITY,
    private val endProbability: Float = END_PROBABILITY,
    private val startFrames: Int = START_FRAMES,
    private val trailingSilenceFrames: Int = TRAILING_SILENCE_FRAMES,
) {
    private var active = false
    private var consecutiveSpeechFrames = 0
    private var consecutiveSilenceFrames = 0

    fun observe(probability: Float): VoiceTurnEvent {
        if (!active) {
            consecutiveSpeechFrames = if (probability >= startProbability) {
                consecutiveSpeechFrames + 1
            } else {
                0
            }
            if (consecutiveSpeechFrames < startFrames) return VoiceTurnEvent.NONE

            active = true
            consecutiveSpeechFrames = 0
            consecutiveSilenceFrames = 0
            return VoiceTurnEvent.STARTED
        }

        consecutiveSilenceFrames = if (probability < endProbability) {
            consecutiveSilenceFrames + 1
        } else {
            0
        }
        if (consecutiveSilenceFrames < trailingSilenceFrames) return VoiceTurnEvent.ACTIVE

        active = false
        consecutiveSpeechFrames = 0
        consecutiveSilenceFrames = 0
        return VoiceTurnEvent.ENDED
    }

    fun reset() {
        active = false
        consecutiveSpeechFrames = 0
        consecutiveSilenceFrames = 0
    }

    companion object {
        const val START_PROBABILITY = 0.5f
        const val END_PROBABILITY = 0.35f
        const val START_FRAMES = 3

        // 56 * (512 / 16 kHz) = 1,792 ms. This is only a local transport
        // boundary; semantic endpointing remains the realtime service's job.
        const val TRAILING_SILENCE_FRAMES = 56
    }
}
