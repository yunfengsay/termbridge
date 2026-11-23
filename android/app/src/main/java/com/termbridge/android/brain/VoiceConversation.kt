package com.termbridge.android.brain

enum class VoiceConversationState {
    STOPPED,
    LISTENING,
    TRANSCRIBING,
    WAITING_FOR_BRAIN,
    SPEAKING,
}

class VoiceConversation {
    var active: Boolean = false
        private set
    var state: VoiceConversationState = VoiceConversationState.STOPPED
        private set

    fun start() {
        active = true
        state = VoiceConversationState.LISTENING
    }

    fun recordingFinished() {
        if (active) state = VoiceConversationState.TRANSCRIBING
    }

    fun transcriptionSent() {
        if (active) state = VoiceConversationState.WAITING_FOR_BRAIN
    }

    fun brainAnswerStarted() {
        if (active) state = VoiceConversationState.SPEAKING
    }

    fun speechFinished(): Boolean {
        if (!active) return false
        state = VoiceConversationState.LISTENING
        return true
    }

    fun stop() {
        active = false
        state = VoiceConversationState.STOPPED
    }
}

class VoiceSilenceDetector(
    private val sampleRate: Int = 16_000,
    private val speechThreshold: Int = 700,
    private val trailingSilenceMs: Int = 1_100,
    private val maximumMs: Int = 15_000,
) {
    private var totalSamples = 0
    private var silentSamplesAfterSpeech = 0
    var heardSpeech: Boolean = false
        private set

    fun accept(samples: ShortArray, count: Int): Boolean {
        if (count <= 0) return false
        totalSamples += count
        var energy = 0L
        for (index in 0 until count) energy += kotlin.math.abs(samples[index].toInt())
        val averageAmplitude = (energy / count).toInt()
        if (averageAmplitude >= speechThreshold) {
            heardSpeech = true
            silentSamplesAfterSpeech = 0
        } else if (heardSpeech) {
            silentSamplesAfterSpeech += count
        }
        return totalSamples >= maximumMs * sampleRate / 1_000 ||
            (heardSpeech && silentSamplesAfterSpeech >= trailingSilenceMs * sampleRate / 1_000)
    }
}
