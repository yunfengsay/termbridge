package com.termbridge.android.brain

/** Deduplicates local barge-in so one speech onset cancels one assistant response. */
internal class VoiceBargeInGate {
    private var potentialSpeech = false
    private var interrupted = false

    fun onResponseStarted() {
        potentialSpeech = false
        interrupted = false
    }

    fun onPotentialSpeechStarted(
        assistantResponding: Boolean,
        localPlaybackActive: Boolean = false,
    ): Boolean {
        if ((!assistantResponding && !localPlaybackActive) || potentialSpeech || interrupted) return false
        potentialSpeech = true
        return true
    }

    fun onAuthorizedSpeechStarted(
        assistantResponding: Boolean,
        localPlaybackActive: Boolean = false,
    ): Boolean {
        if ((!assistantResponding && !localPlaybackActive) || interrupted) return false
        potentialSpeech = false
        interrupted = true
        return true
    }

    fun onPotentialSpeechRejected(): Boolean {
        if (!potentialSpeech || interrupted) return false
        potentialSpeech = false
        return true
    }

    fun onPotentialSpeechTimedOut(): Boolean = onPotentialSpeechRejected()

    fun onSpeechStarted(
        assistantResponding: Boolean,
        localPlaybackActive: Boolean = false,
    ): Boolean = onAuthorizedSpeechStarted(assistantResponding, localPlaybackActive)

    fun onListening() {
        potentialSpeech = false
        interrupted = false
    }
}
