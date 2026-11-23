package com.termbridge.android.brain

import android.content.Context
import android.media.MediaPlayer
import android.media.PlaybackParams
import android.os.Bundle
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.util.Log
import java.io.File
import java.util.ArrayDeque

class BrainSpeaker(
    context: Context,
    initialPlaybackRate: Float = VoiceSettingsStore.DEFAULT_PLAYBACK_RATE,
    private val onUnavailable: () -> Unit,
    private val onStarted: (String) -> Unit,
    private val onCompleted: (String) -> Unit,
) {
    private data class PendingSpeech(val id: String, val text: String)
    private data class PendingAudio(val id: String, val data: ByteArray)

    private val appContext = context.applicationContext
    private val pending = ArrayDeque<PendingSpeech>()
    private val pendingAudio = ArrayDeque<PendingAudio>()
    private var engine: TextToSpeech? = null
    private var player: MediaPlayer? = null
    private var audioFile: File? = null
    private var ready = false
    private var closed = false
    private var unavailableReported = false
    private var playbackRate = VoiceSettingsStore.normalizePlaybackRate(initialPlaybackRate)

    private fun initializeEngine() {
        if (engine != null || closed) return
        engine = TextToSpeech(appContext) { status ->
            if (closed) return@TextToSpeech
            if (status != TextToSpeech.SUCCESS) {
                reportUnavailable()
                return@TextToSpeech
            }
            ready = true
            engine?.setSpeechRate(playbackRate)
            engine?.setPitch(1.0f)
            engine?.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
                override fun onStart(utteranceId: String?) {
                    Log.d(LOG_TAG, "utterance started")
                    utteranceId?.let(onStarted)
                }

                override fun onDone(utteranceId: String?) {
                    Log.d(LOG_TAG, "utterance completed")
                    utteranceId?.let(onCompleted)
                }
                @Deprecated("Deprecated by Android")
                override fun onError(utteranceId: String?) = reportUnavailable()
            })
            while (pending.isNotEmpty()) speakNow(pending.removeFirst())
        }
    }

    fun speak(messageId: String, source: String): Boolean {
        val text = BrainSpeechText.normalize(source)
        if (text.isBlank() || closed) return false
        val speech = PendingSpeech(messageId, text)
        if (ready) {
            speakNow(speech)
        } else {
            pending.addLast(speech)
            initializeEngine()
        }
        return true
    }

    fun play(messageId: String, audio: ByteArray): Boolean {
        if (audio.isEmpty() || closed) return false
        pendingAudio.addLast(PendingAudio(messageId, audio))
        if (player == null) playNext()
        return true
    }

    fun setPlaybackRate(rate: Float) {
        playbackRate = VoiceSettingsStore.normalizePlaybackRate(rate)
        engine?.setSpeechRate(playbackRate)
    }

    fun stop() {
        pending.clear()
        pendingAudio.clear()
        engine?.stop()
        releasePlayer()
    }

    fun shutdown() {
        closed = true
        pending.clear()
        pendingAudio.clear()
        releasePlayer()
        engine?.stop()
        engine?.shutdown()
        engine = null
    }

    private fun speakNow(speech: PendingSpeech) {
        val tts = engine ?: return
        val requested = BrainSpeechText.localeFor(speech.text)
        val availability = tts.setLanguage(requested)
        if (availability == TextToSpeech.LANG_MISSING_DATA || availability == TextToSpeech.LANG_NOT_SUPPORTED) {
            val fallback = tts.setLanguage(java.util.Locale.getDefault())
            if (fallback == TextToSpeech.LANG_MISSING_DATA || fallback == TextToSpeech.LANG_NOT_SUPPORTED) {
                reportUnavailable()
                return
            }
        }
        val params = Bundle().apply {
            putString(TextToSpeech.Engine.KEY_PARAM_UTTERANCE_ID, speech.id)
        }
        val result = tts.speak(speech.text, TextToSpeech.QUEUE_ADD, params, speech.id)
        if (result == TextToSpeech.ERROR) reportUnavailable()
    }

    private fun playNext() {
        val speech = pendingAudio.pollFirst() ?: return
        val file = runCatching {
            File.createTempFile("termbridge-voice-", ".wav", appContext.cacheDir).also {
                it.writeBytes(speech.data)
            }
        }.getOrElse {
            onCompleted(speech.id)
            reportUnavailable()
            return
        }
        audioFile = file
        player = runCatching {
            MediaPlayer().apply {
                setDataSource(file.absolutePath)
                setOnPreparedListener {
                    onStarted(speech.id)
                    runCatching {
                        it.playbackParams = PlaybackParams().setSpeed(playbackRate).setPitch(1f)
                    }
                    it.start()
                }
                setOnCompletionListener { finishAudio(speech.id) }
                setOnErrorListener { _, _, _ ->
                    finishAudio(speech.id)
                    reportUnavailable()
                    true
                }
                prepareAsync()
            }
        }.getOrElse {
            releasePlayer()
            onCompleted(speech.id)
            reportUnavailable()
            null
        }
    }

    private fun finishAudio(messageId: String) {
        releasePlayer()
        onCompleted(messageId)
        playNext()
    }

    private fun releasePlayer() {
        player?.setOnPreparedListener(null)
        player?.setOnCompletionListener(null)
        player?.setOnErrorListener(null)
        runCatching { player?.stop() }
        player?.release()
        player = null
        audioFile?.delete()
        audioFile = null
    }

    private fun reportUnavailable() {
        if (unavailableReported || closed) return
        unavailableReported = true
        onUnavailable()
    }

    private companion object {
        const val LOG_TAG = "TermbridgeTTS"
    }
}
