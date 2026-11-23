package com.termbridge.android.brain

/**
 * Keeps authorized microphone audio on the phone until the realtime Host has accepted it.
 *
 * Audio already written to a broken socket is replayed from the start of its utterance when
 * a new remote session is created. Only one committed utterance is in flight at a time so two
 * offline turns can never be merged into one server-side turn.
 */
class VoiceAudioOutbox(private val maxBytes: Int) {
    private sealed interface Event {
        data class Audio(val pcm16: ByteArray) : Event
        data object Commit : Event
    }

    private val events = mutableListOf<Event>()
    private var sendCursor = 0
    private var awaitingTranscript = false

    var queuedBytes: Int = 0
        private set

    val hasPending: Boolean
        get() = events.isNotEmpty()

    val pendingTurnCount: Int
        get() = events.count { it === Event.Commit }

    @Synchronized
    fun offerAudio(pcm16: ByteArray): Boolean {
        if (pcm16.isEmpty()) return true
        if (queuedBytes + pcm16.size > maxBytes) return false
        events += Event.Audio(pcm16.copyOf())
        queuedBytes += pcm16.size
        return true
    }

    @Synchronized
    fun offerCommit(): Boolean {
        val lastCommit = events.indexOfLast { it === Event.Commit }
        if (events.drop(lastCommit + 1).none { it is Event.Audio }) return false
        events += Event.Commit
        return true
    }

    @Synchronized
    fun beginNewRemoteSession() {
        sendCursor = 0
        awaitingTranscript = false
    }

    @Synchronized
    fun flush(
        sendAudio: (ByteArray) -> Boolean,
        sendCommit: () -> Boolean,
    ): Boolean {
        if (awaitingTranscript) return true
        while (sendCursor < events.size) {
            val sent = when (val event = events[sendCursor]) {
                is Event.Audio -> sendAudio(event.pcm16)
                Event.Commit -> sendCommit()
            }
            if (!sent) return false
            sendCursor += 1
            if (events[sendCursor - 1] === Event.Commit) {
                awaitingTranscript = true
                return true
            }
        }
        return true
    }

    @Synchronized
    fun acknowledgeTranscript() {
        val commit = events.indexOfFirst { it === Event.Commit }
        if (commit < 0) return
        val removed = events.subList(0, commit + 1)
        queuedBytes -= removed.sumOf { if (it is Event.Audio) it.pcm16.size else 0 }
        removed.clear()
        sendCursor = (sendCursor - commit - 1).coerceAtLeast(0)
        awaitingTranscript = false
    }

    @Synchronized
    fun clear() {
        events.clear()
        queuedBytes = 0
        sendCursor = 0
        awaitingTranscript = false
    }
}
