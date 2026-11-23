package com.termbridge.android.brain

/** Bounded identity admission for continuous audio. Every chunk is checked against
 * the enrolled identity; an accepted onset never grants the rest of a call access.
 * No online anchor learning: background speech must not gradually become the owner.
 * This rejects windows, it does NOT separate simultaneous speakers within a window.
 */
internal class StreamingSpeakerGate(
    private val windowFrames: Int = 32, // 1.024 s at 16 kHz / 512 samples
    private val measure: (List<ShortArray>) -> Float?,
) {
    data class Result(
        val audio: List<ShortArray> = emptyList(),
        val authorized: Boolean = false,
        val rejected: Boolean = false,
        val unavailable: Boolean = false,
    )
    private val pending = ArrayList<ShortArray>()
    private var missingMeasurements = 0
    private var authorized = false

    init { require(windowFrames > 0) }

    fun accept(frame: ShortArray, speech: Boolean): Result {
        if (speech) pending.add(frame.copyOf())
        if (pending.isEmpty()) { authorized = false; return Result() }
        if (speech && pending.size < windowFrames) return Result()
        val audio = pending.toList()
        pending.clear()
        val score = measure(audio)?.takeIf { it.isFinite() }
        val threshold = if (authorized) TargetSpeakerTracker.CONTINUATION_THRESHOLD
            else TargetSpeakerTracker.AUTHORIZATION_THRESHOLD
        if (score == null) {
            missingMeasurements++
            authorized = false
            return Result(rejected = true, unavailable = missingMeasurements >= 3)
        }
        missingMeasurements = 0
        val accepted = score >= threshold
        authorized = accepted && speech
        return Result(audio = if (accepted) audio else emptyList(), authorized = accepted, rejected = !accepted)
    }

    fun reset() {
        pending.clear()
        missingMeasurements = 0
        authorized = false
    }
}
