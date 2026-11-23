package com.termbridge.android.brain

/** Keeps a bounded, call-local voice anchor without discarding the enrolled identity. */
internal class ConversationSpeakerVerifier(
    enrolledProfile: FloatArray,
    private val recentWeight: Float = RECENT_WEIGHT,
) {
    private val enrolled = VoiceEmbedding.normalize(enrolledProfile)
    private var recent: FloatArray? = null

    init {
        require(enrolled.isNotEmpty())
        require(recentWeight in 0f..1f)
    }

    fun similarity(candidate: FloatArray): Float {
        val enrolledSimilarity = VoiceEmbedding.similarity(enrolled, candidate)
        val recentSimilarity = recent?.let { VoiceEmbedding.similarity(it, candidate) }
            ?: return enrolledSimilarity
        return recentSimilarity * recentWeight + enrolledSimilarity * (1f - recentWeight)
    }

    fun remember(candidate: FloatArray) {
        if (candidate.size != enrolled.size) return
        // Only high-confidence samples may move the rolling anchor. A barely
        // authorized window (TTS bleed-through, overlapping voices, noise)
        // otherwise poisons the anchor and locks the real speaker out.
        if (similarity(candidate) < REMEMBER_THRESHOLD) return
        recent = recent?.let { VoiceEmbedding.average(listOf(it, candidate)) }
            ?: VoiceEmbedding.normalize(candidate)
    }

    /** Drops the call-local anchor so matching falls back to the enrolled identity. */
    fun resetRecent() {
        recent = null
    }

    private companion object {
        const val RECENT_WEIGHT = 0.75f
        const val REMEMBER_THRESHOLD = 0.60f
    }
}
