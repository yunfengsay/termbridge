package com.termbridge.android.brain

import android.content.Context
import android.util.Log

data class VoiceSpeakerRouteResult(
    val enabled: Boolean,
    val callActive: Boolean,
    val applied: Boolean,
)

/** Process-local bridge between phone actions and the active Voice Call audio route. */
object VoiceCallSpeakerController {
    @Volatile private var activeSession: CallAudioSession? = null

    @Synchronized
    fun attach(session: CallAudioSession) {
        activeSession = session
    }

    @Synchronized
    fun detach(session: CallAudioSession) {
        if (activeSession === session) activeSession = null
    }

    @Synchronized
    fun set(context: Context, enabled: Boolean): VoiceSpeakerRouteResult {
        val session = activeSession
        val applied = session?.setSpeakerphoneEnabled(enabled) ?: true
        if (applied) VoiceSettingsStore(context).setSpeakerphoneEnabled(enabled)
        val actual = session?.isSpeakerphoneEnabled() ?: enabled
        Log.i(TAG, "speaker requested=$enabled actual=$actual active=${session != null} applied=$applied")
        return VoiceSpeakerRouteResult(actual, session != null, applied)
    }

    private const val TAG = "TermbridgeAudio"
}
