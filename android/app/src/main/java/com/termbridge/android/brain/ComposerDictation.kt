package com.termbridge.android.brain

import android.content.Context
import android.os.Handler
import android.os.Looper
import com.termbridge.android.R
import com.termbridge.android.protocol.ControlMessage
import java.util.UUID
import java.util.concurrent.Executors

/** Foreground-only ASR. Owns no Brain conversation, TTS, overlay, or task execution. */
class ComposerDictation(
    private val context: Context,
    private val send: (Array<Pair<String, Any?>>) -> Boolean,
    private val render: (String, Boolean, Boolean, Float) -> Unit,
    private val submit: () -> Unit,
    private val reportError: (String) -> Unit,
) {
    private val main = Handler(Looper.getMainLooper())
    private val loader = Executors.newSingleThreadExecutor()
    private var requestId: String? = null
    private var draft = DictationDraft("", "发送")
    private var capture: OnDeviceVoiceCapture? = null
    private val route = CallAudioSession(context)
    private var closed = false
    private var finishing = false
    private var sendAfterFinish = false
    private var audioPending = false
    private var level = 0f
    val active: Boolean get() = requestId != null
    private val finishTimeout = Runnable { fail(context.getString(R.string.dictation_timeout)) }
    private val recordLimit = Runnable { finish(false) }

    fun start(initial: String, settings: VoiceSettings, locale: String) {
        if (active || closed) return
        val id = UUID.randomUUID().toString()
        requestId = id
        draft = DictationDraft(initial, settings.sendKeyword)
        finishing = false
        sendAfterFinish = false
        audioPending = false
        level = 0f
        update()
        loader.execute {
            val loaded = runCatching { OnDeviceVoiceModels(context.applicationContext) }
            main.post {
                if (requestId != id || closed) { loaded.getOrNull()?.close(); return@post }
                loaded.onFailure { fail(it.message ?: context.getString(R.string.brain_voice_unavailable)) }
                    .onSuccess { models ->
                        if (!send(arrayOf("t" to "brain_transcribe_start", "requestId" to id, "locale" to locale,
                                "hints" to (settings.technicalTerms + settings.sendKeyword).distinct().take(64)))) {
                            models.close(); fail(context.getString(R.string.disconnected)); return@onSuccess
                        }
                        route.start(settings.speakerphoneEnabled, acquireFocus = false)
                        val recorder = OnDeviceVoiceCapture(models, null, enrollment = false, verifySpeaker = false,
                            passthrough = false, noiseFilterEnabled = settings.noiseFilterEnabled,
                            noiseSensitivity = settings.noiseSensitivity,
                            listener = object : OnDeviceVoiceCapture.Listener {
                                override fun onLevel(value: Float) { main.post {
                                    if (requestId == id && !finishing) { level = value; update() }
                                } }
                                override fun onSpeechDetected() {}
                                override fun onAuthorizedSpeechDetected() {}
                                override fun onAuthorizedAudio(pcm16: ByteArray) { main.post {
                                    if (requestId == id && !finishing) {
                                        if (send(arrayOf("t" to "brain_transcribe_audio", "requestId" to id, "data" to pcm16))) audioPending = true
                                        else fail(context.getString(R.string.disconnected))
                                    }
                                } }
                                override fun onUtteranceCommitted() { main.post {
                                    if (requestId == id && !finishing && audioPending) {
                                        send(arrayOf("t" to "brain_transcribe_commit", "requestId" to id))
                                        audioPending = false
                                    }
                                } }
                                override fun onVoiceRejected() {}
                                override fun onEnrollmentSample(embedding: FloatArray) {}
                                override fun onError(message: String) { main.post { if (requestId == id) fail(message) } }
                                override fun onCaptureClosed() { models.close() }
                            })
                        capture = recorder
                        if (!recorder.start()) {
                            models.close(); fail(context.getString(R.string.brain_voice_unavailable))
                        } else main.postDelayed(recordLimit, 50_000)
                    }
            }
        }
    }

    fun accept(message: ControlMessage): Boolean {
        if (message.type != "brain_transcribe_result" || message.string("requestId") != requestId || !active) return false
        message.string("error")?.let { fail(it); return true }
        val text = message.string("text")
        if (text != null && draft.accept(text, message.boolean("final") == true)) {
            sendAfterFinish = true
            finish(true)
        }
        update()
        if (message.boolean("finished") == true) {
            val shouldSubmit = sendAfterFinish && draft.text.isNotBlank()
            cancel()
            if (shouldSubmit) submit()
        }
        return true
    }

    /** Finish ASR first so the last words are not lost on a visible Send tap. */
    fun finish(shouldSubmit: Boolean) {
        val id = requestId ?: return
        if (capture == null && !finishing) {
            cancel()
            if (shouldSubmit && draft.text.isNotBlank()) submit()
            return
        }
        sendAfterFinish = sendAfterFinish || shouldSubmit
        if (finishing) return
        finishing = true
        main.removeCallbacks(recordLimit)
        capture?.stop(); capture = null
        route.stop()
        if (audioPending) send(arrayOf("t" to "brain_transcribe_commit", "requestId" to id))
        if (!send(arrayOf("t" to "brain_transcribe_finish", "requestId" to id))) {
            fail(context.getString(R.string.disconnected)); return
        }
        main.postDelayed(finishTimeout, 8000)
        update()
    }

    /** Retain visible text; late frames/results cannot overwrite manual edits or submit. */
    fun cancel() {
        val id = requestId
        requestId = null
        main.removeCallbacks(recordLimit); main.removeCallbacks(finishTimeout)
        capture?.stop(); capture = null
        route.stop()
        if (id != null) send(arrayOf("t" to "brain_transcribe_cancel", "requestId" to id))
        finishing = false
        level = 0f
        update()
    }

    fun close() { closed = true; cancel(); loader.shutdown() }
    private fun fail(message: String) { cancel(); reportError(message) }
    private fun update() = render(draft.text, active, finishing, level)
}
