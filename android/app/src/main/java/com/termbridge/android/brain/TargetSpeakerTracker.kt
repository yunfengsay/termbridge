package com.termbridge.android.brain

internal enum class TargetSpeakerDecision {
    WAITING,
    AUTHORIZED,
    ACCEPTED,
    HOLD,
    TARGET_ENDED,
}

/**
 * Applies hysteresis to rolling speaker-similarity measurements.
 *
 * A turn first has to match the enrolled voice. Once locked, a slightly lower
 * threshold keeps natural changes in distance and pronunciation from chopping
 * the turn. Audio is held after the first mismatch and the target turn ends
 * only after repeated mismatches, so a brief noisy window cannot steal it.
 */
internal class TargetSpeakerTracker(
    private val authorizationThreshold: Float = AUTHORIZATION_THRESHOLD,
    private val continuationThreshold: Float = CONTINUATION_THRESHOLD,
    private val mismatchesToEnd: Int = MISMATCHES_TO_END,
) {
    private var authorized = false
    private var consecutiveMismatches = 0

    init {
        require(continuationThreshold <= authorizationThreshold)
        require(mismatchesToEnd > 0)
    }

    fun observe(similarity: Float?): TargetSpeakerDecision {
        if (!authorized) {
            if (similarity == null || similarity < authorizationThreshold) {
                return TargetSpeakerDecision.WAITING
            }
            authorized = true
            consecutiveMismatches = 0
            return TargetSpeakerDecision.AUTHORIZED
        }

        if (similarity != null && similarity >= continuationThreshold) {
            consecutiveMismatches = 0
            return TargetSpeakerDecision.ACCEPTED
        }

        consecutiveMismatches += 1
        if (consecutiveMismatches < mismatchesToEnd) {
            return TargetSpeakerDecision.HOLD
        }
        return TargetSpeakerDecision.TARGET_ENDED
    }

    fun reset() {
        authorized = false
        consecutiveMismatches = 0
    }

    companion object {
        // Deliberately permissive: blocking the real owner is far worse than
        // letting a clearly different voice through. Only obvious strangers
        // (TV, passers-by) should fall below this line.
        const val AUTHORIZATION_THRESHOLD = 0.30f
        const val CONTINUATION_THRESHOLD = 0.25f
        const val MISMATCHES_TO_END = 2
    }
}
