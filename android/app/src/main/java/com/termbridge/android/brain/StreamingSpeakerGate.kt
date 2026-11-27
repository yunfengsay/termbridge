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
        val score: Float? = null,
    )
    private val pending = ArrayList<ShortArray>()
    private val voiced = ArrayList<ShortArray>()
    private val voicedRaw = ArrayList<ShortArray>()
    private var missingMeasurements = 0
    private var authorized = false

    init { require(windowFrames > 0) }

    /**
     * @param frame Outgoing (possibly denoised) frame to release once authorized.
     * @param speech Whether the noise gate is open (includes onset pre-roll and trailing hangover).
     * @param voicedForSpeaker Whether this frame carries vocal activity for CAM++ scoring
     *   (excludes pure pre-roll / hangover silence so silence cannot dilute speaker similarity).
     * @param rawFrame Optional pre-denoiser frame matching the raw enrollment domain; evaluated
     *   only when the denoised score falls below threshold.
     */
    fun accept(
        frame: ShortArray,
        speech: Boolean,
        voicedForSpeaker: Boolean = speech,
        rawFrame: ShortArray? = null,
    ): Result {
        if (speech) {
            val copy = frame.copyOf()
            pending.add(copy)
            if (voicedForSpeaker) {
                voiced.add(copy)
                if (rawFrame != null) voicedRaw.add(rawFrame.copyOf())
            }
        }
        if (pending.isEmpty()) { authorized = false; return Result() }
        if (speech && pending.size < windowFrames) return Result()
        val audio = pending.toList()
        val speakerSample = voiced.toList()
        val rawSample = voicedRaw.toList()
        pending.clear()
        voiced.clear()
        voicedRaw.clear()

        // Pure hangover / pre-roll silence contains no voice to verify. Never emit a false
        // "another voice ignored" rejection or count it as a broken speaker model; let an
        // already-authorized utterance finish its trailing hangover cleanly.
        if (speakerSample.isEmpty()) {
            val wasAuthorized = authorized
            if (!speech) authorized = false
            return if (wasAuthorized) Result(audio = audio) else Result()
        }

        val threshold = if (authorized) TargetSpeakerTracker.CONTINUATION_THRESHOLD
            else TargetSpeakerTracker.AUTHORIZATION_THRESHOLD
        var score = measure(speakerSample)?.takeIf { it.isFinite() }
        if ((score == null || score < threshold) && rawSample.isNotEmpty()) {
            val rawScore = measure(rawSample)?.takeIf { it.isFinite() }
            if (rawScore != null && (score == null || rawScore > score)) {
                score = rawScore
            }
        }
        if (score == null) {
            val longEnoughForModel = speakerSample.size >= minOf(windowFrames, MIN_FRAMES_FOR_MODEL_CHECK)
            if (longEnoughForModel) missingMeasurements++
            authorized = false
            return Result(rejected = true, unavailable = missingMeasurements >= 3)
        }
        missingMeasurements = 0
        val accepted = score >= threshold
        authorized = accepted && speech
        return Result(
            audio = if (accepted) audio else emptyList(),
            authorized = accepted,
            rejected = !accepted,
            score = score,
        )
    }

    fun reset() {
        pending.clear()
        voiced.clear()
        voicedRaw.clear()
        missingMeasurements = 0
        authorized = false
    }

    private companion object {
        const val MIN_FRAMES_FOR_MODEL_CHECK = 10
    }
}
