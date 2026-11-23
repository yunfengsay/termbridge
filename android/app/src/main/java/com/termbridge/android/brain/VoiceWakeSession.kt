package com.termbridge.android.brain

enum class VoiceInteractionMode(val value: String) {
    CONTINUOUS("continuous"), WAKE_WORD("wake_word");
    companion object {
        fun from(value: String?) = entries.firstOrNull { it.value == value } ?: CONTINUOUS
    }
}

/** Local privacy boundary. A cloud reconnect cannot grant permission to upload audio. */
class VoiceWakeSession {
    // DRAINING denies new microphone frames but retains the remote answer/tool lifecycle.
    enum class State { STOPPED, WAITING, ACTIVE, DRAINING }
    @Volatile var state = State.STOPPED
        private set
    @Volatile var generation = 0L
        private set
    private var mode = VoiceInteractionMode.CONTINUOUS
    private var activatedAt = 0L
    private var answerFinishedAt: Long? = null
    private var toolsActive = false
    private var speechGeneration = 0L
    private var responseSpeechGeneration = -1L

    val localStandby: Boolean get() = state == State.WAITING || state == State.DRAINING
    val canDrainAuthorizedAudio: Boolean get() = state == State.ACTIVE || state == State.DRAINING

    @Synchronized fun start(mode: VoiceInteractionMode, now: Long) {
        this.mode = mode
        generation++
        state = if (mode == VoiceInteractionMode.WAKE_WORD) State.WAITING else State.ACTIVE
        activatedAt = now
        answerFinishedAt = null
        toolsActive = false
        speechGeneration = 0
        responseSpeechGeneration = -1
    }

    @Synchronized fun wake(now: Long): Boolean {
        if (!localStandby) return false
        generation++
        state = State.ACTIVE
        activatedAt = now
        answerFinishedAt = null
        speechGeneration = 0
        responseSpeechGeneration = -1
        return true
    }

    /** Explicit end-of-input is NOT hangup, tool cancellation, or permission to drop the answer. */
    @Synchronized fun finishInput(): Boolean {
        if (state != State.ACTIVE || mode != VoiceInteractionMode.WAKE_WORD) return false
        generation++
        state = State.DRAINING
        return true
    }

    @Synchronized fun finishInput(epoch: Long, sealAuthorizedInput: () -> Unit): Boolean {
        if (generation != epoch || state != State.ACTIVE || mode != VoiceInteractionMode.WAKE_WORD) return false
        sealAuthorizedInput()
        return finishInput()
    }

    @Synchronized fun userSpeech() { speechGeneration++; answerFinishedAt = null }
    @Synchronized fun responseStarted() { responseSpeechGeneration = speechGeneration; answerFinishedAt = null }
    @Synchronized fun toolActivity(active: Boolean) { toolsActive = active; answerFinishedAt = null }
    @Synchronized fun responseFinished(hasAnswer: Boolean, now: Long) {
        if (hasAnswer && canDrainAuthorizedAudio && responseSpeechGeneration == speechGeneration) answerFinishedAt = now
    }

    @Synchronized fun shouldPark(now: Long, playbackPending: Boolean, responding: Boolean): Boolean {
        if (mode != VoiceInteractionMode.WAKE_WORD || !canDrainAuthorizedAudio) return false
        return !playbackPending && !responding && !toolsActive &&
            answerFinishedAt?.let { now - it >= ANSWER_SETTLE_MS } == true
    }

    @Synchronized fun shouldSealInput(now: Long): Boolean = mode == VoiceInteractionMode.WAKE_WORD &&
        state == State.ACTIVE && now - activatedAt >= MAX_ACTIVE_MS

    @Synchronized fun park() {
        if (mode != VoiceInteractionMode.WAKE_WORD || state == State.STOPPED) return
        generation++
        state = State.WAITING
        answerFinishedAt = null
        toolsActive = false
    }

    @Synchronized fun stop() { generation++; state = State.STOPPED; answerFinishedAt = null }

    /** Also excludes stale frames queued before hangup/mode switch/another wake cycle. */
    @Synchronized fun forward(epoch: Long, send: () -> Unit): Boolean {
        if (state != State.ACTIVE || epoch != generation) return false
        send()
        return true
    }

    companion object {
        const val MAX_ACTIVE_MS = 120_000L
        const val ANSWER_SETTLE_MS = 600L
    }
}
