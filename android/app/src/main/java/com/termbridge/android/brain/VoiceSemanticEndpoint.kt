package com.termbridge.android.brain

/** Closes a server-side semantic-VAD turn after local speaker filtering removes background audio. */
internal object VoiceSemanticEndpoint {
    private const val SAMPLE_RATE = 16_000
    private const val SILENCE_DURATION_MS = 1_600
    private val silencePcm16 = ByteArray(SAMPLE_RATE * 2 * SILENCE_DURATION_MS / 1_000)

    fun finishAfterFilteredBackground(
        sendAudio: (ByteArray) -> Unit,
        commit: () -> Unit,
    ) {
        sendAudio(silencePcm16)
        commit()
    }
}
