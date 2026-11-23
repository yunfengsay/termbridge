package com.termbridge.android.brain

import android.content.Context

/** Capture-thread owner of KWS; the session, not a reconnect callback, grants an upload epoch. */
class WakeWordCaptureGate(
    private val context: Context,
    private val session: VoiceWakeSession,
    private val keyword: () -> String,
    private val onWake: () -> Unit,
) : AutoCloseable {
    private var detector: OnDeviceWakeWord? = null
    private var detectorWord: String? = null
    private var detectorEpoch = -1L
    private val preRoll = ArrayDeque<ShortArray>()
    private var approvedPreRoll: List<ShortArray> = emptyList()

    fun accept(samples: ShortArray, now: Long): Long? {
        if (session.state == VoiceWakeSession.State.STOPPED) return null
        if (session.localStandby) {
            val word = keyword()
            if (detectorWord != word) {
                close()
                detector = OnDeviceWakeWord(context, word)
                detectorWord = word
            }
            if (detectorEpoch != session.generation) {
                detector?.reset()
                detectorEpoch = session.generation
                preRoll.clear()
            }
            if (detector?.accept(samples) == true && session.wake(now)) {
                approvedPreRoll = preRoll.toList()
                preRoll.clear()
                onWake()
            } else {
                preRoll.addLast(samples.copyOf())
                while (preRoll.size > PRE_ROLL_FRAMES) preRoll.removeFirst()
            }
        }
        return session.generation.takeIf { session.state == VoiceWakeSession.State.ACTIVE }
    }

    fun takeApprovedPreRoll(): List<ShortArray> = approvedPreRoll.also { approvedPreRoll = emptyList() }

    override fun close() {
        detector?.close(); detector = null; detectorWord = null
        preRoll.clear(); approvedPreRoll = emptyList()
    }

    companion object {
        // 384 ms RAM only, released only after KWS acceptance; never persisted or queued while waiting.
        const val PRE_ROLL_FRAMES = 12
    }
}
