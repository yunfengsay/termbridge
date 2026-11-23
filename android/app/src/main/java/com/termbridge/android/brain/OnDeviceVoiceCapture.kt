package com.termbridge.android.brain

import android.annotation.SuppressLint
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.AudioRouting
import android.media.MediaRecorder
import android.media.audiofx.AcousticEchoCanceler
import android.media.audiofx.NoiseSuppressor
import android.util.Log
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.sqrt

internal fun voiceCaptureAudioSource(): Int = MediaRecorder.AudioSource.VOICE_COMMUNICATION

class OnDeviceVoiceCapture(
    private val models: OnDeviceVoiceModels,
    private val profile: FloatArray?,
    private val enrollment: Boolean,
    private val verifySpeaker: Boolean = true,
    // Continuous PCM, not local turn commits. Enhancement/gates may delay a
    // frame or replace it with silence; the cloud still owns semantic endpointing.
    private val passthrough: Boolean = false,
    private val noiseFilterEnabled: Boolean = true,
    private val noiseSensitivity: VoiceNoiseSensitivity = VoiceNoiseSensitivity.CONSERVATIVE,
    private val listener: Listener,
) {
    interface Listener {
        /** Capture-thread local-only gate, before VAD, denoising, outbox or network. */
        fun onLocalFrame(samples: ShortArray): Boolean = true
        fun takeAuthorizedPreRoll(): List<ShortArray> = emptyList()
        fun onCaptureClosed() {}
        fun onLevel(level: Float)
        /** Passthrough only: whether the current window is sent as real audio or silence. */
        fun onSpeechGate(audible: Boolean) {}

        /** Passthrough only: smoothed cleaned-audio probability and the adaptive gate threshold. */
        fun onSpeechProbability(probability: Float, threshold: Float) {}
        fun onSpeechDetected()
        fun onAuthorizedSpeechDetected()
        fun onAuthorizedAudio(pcm16: ByteArray)
        fun onUtteranceCommitted()
        fun onVoiceRejected()
        fun onEnrollmentSample(embedding: FloatArray)
        fun onError(message: String)
    }

    private val running = AtomicBoolean(false)
    private val conversationSpeakerVerifier = if (!enrollment && verifySpeaker) {
        ConversationSpeakerVerifier(requireNotNull(profile))
    } else {
        null
    }
    @Volatile private var audioRecord: AudioRecord? = null
    private var consecutiveRejections = 0
    private val streamingSpeakerGate = if (passthrough && !enrollment && verifySpeaker) {
        StreamingSpeakerGate { frames ->
            val start = android.os.SystemClock.elapsedRealtime()
            val score = models.embedding(frames)?.let { VoiceEmbedding.similarity(requireNotNull(profile), it) }
            Log.i(TAG, "speaker window frames=${frames.size} measured=${score != null} inferenceMs=${android.os.SystemClock.elapsedRealtime() - start}")
            score
        }
    } else null
    private var streamingSpeakerAccepted = false
    private var streamingSpeakerRejected = false
    private val verifiedPlayback = ArrayDeque<ShortArray>()

    // A run of rejections almost always means the rolling anchor drifted (for
    // example TTS bleed-through was averaged in), not that a stranger keeps
    // talking. Drop the anchor so matching returns to the enrolled identity.
    private fun registerRejection() {
        consecutiveRejections += 1
        if (consecutiveRejections >= REJECTIONS_TO_RESET_ANCHOR) {
            conversationSpeakerVerifier?.resetRecent()
            consecutiveRejections = 0
        }
    }

    @SuppressLint("MissingPermission")
    fun start(): Boolean {
        if (!running.compareAndSet(false, true)) return false
        val minimum = AudioRecord.getMinBufferSize(
            OnDeviceVoiceModels.SAMPLE_RATE,
            AudioFormat.CHANNEL_IN_MONO,
            AudioFormat.ENCODING_PCM_16BIT,
        )
        if (minimum <= 0) {
            running.set(false)
            listener.onError("This microphone format is unavailable")
            return false
        }
        val audioSource = voiceCaptureAudioSource()
        val recorder = runCatching {
            AudioRecord(
                audioSource,
                OnDeviceVoiceModels.SAMPLE_RATE,
                AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT,
                maxOf(minimum * 2, OnDeviceVoiceModels.SAMPLE_RATE),
            )
        }.getOrElse {
            running.set(false)
            listener.onError(it.message ?: "Could not open the microphone")
            return false
        }
        if (recorder.state != AudioRecord.STATE_INITIALIZED) {
            running.set(false)
            recorder.release()
            listener.onError("Could not initialize the microphone")
            return false
        }
        audioRecord = recorder
        val echoCanceler = runCatching {
            if (AcousticEchoCanceler.isAvailable()) {
                AcousticEchoCanceler.create(recorder.audioSessionId)?.apply { enabled = true }
            } else null
        }.getOrNull()
        val noiseSuppressor = runCatching {
            if (NoiseSuppressor.isAvailable()) {
                NoiseSuppressor.create(recorder.audioSessionId)?.apply { enabled = true }
            } else null
        }.getOrNull()
        val routingListener = AudioRouting.OnRoutingChangedListener { routing ->
            val inputType = (routing as? AudioRecord)?.routedDevice?.type
            Log.i(TAG, "capture route inputType=${inputType ?: "none"}")
        }
        recorder.addOnRoutingChangedListener(routingListener, null)
        Log.i(
            TAG,
            "capture source=$audioSource aec=${runCatching { echoCanceler?.enabled == true }.getOrDefault(false)} " +
                "ns=${runCatching { noiseSuppressor?.enabled == true }.getOrDefault(false)} " +
                "speakerVerification=$verifySpeaker continuous=$passthrough",
        )
        Thread({
            try {
                capture(recorder)
            } finally {
                recorder.removeOnRoutingChangedListener(routingListener)
                echoCanceler?.release()
                noiseSuppressor?.release()
            }
        }, "termbridge-on-device-voice").start()
        return true
    }

    fun stop() {
        if (!running.getAndSet(false)) return
        audioRecord?.let { runCatching { it.stop() } }
    }

    private fun capture(recorder: AudioRecord) {
        val state = SegmentState()
        var failure: String? = null
        var locallyAllowed = true
        try {
            models.resetVad()
            models.resetCleanVad()
            recorder.startRecording()
            while (running.get()) {
                val frame = readFrame(recorder) ?: break
                listener.onLevel(level(frame))
                if (!listener.onLocalFrame(frame)) {
                    if (locallyAllowed) {
                        models.resetVad()
                        models.resetCleanVad()
                        passthroughPreRoll.clear()
                        passthroughNoiseGate = VoiceNoiseGate(noiseSensitivity)
                        passthroughGateActive = false
                        passthroughSpeechFrames = 0
                        passthroughSpeechNotified = false
                        passthroughAudibleStreak = 0
                        passthroughForcedSilence = 0
                        streamingSpeakerGate?.reset()
                        streamingSpeakerAccepted = false
                        streamingSpeakerRejected = false
                        verifiedPlayback.clear()
                    }
                    locallyAllowed = false
                    continue
                }
                locallyAllowed = true
                listener.takeAuthorizedPreRoll().forEach { approved ->
                    processFrame(approved, models.speechProbability(approved), state)
                }
                processFrame(frame, models.speechProbability(frame), state)
                if (enrollment && state.enrollmentComplete) break
            }
            if (running.get() && passthrough && noiseFilterEnabled) {
                val tail = models.finishDenoise()
                tail.frames.forEachIndexed { index, audio ->
                    emitPassthrough(audio, tail.probabilities[index], tail.probabilities[index])
                }
            }
        } catch (error: Exception) {
            if (running.get()) failure = error.message ?: "Microphone recording failed"
        } finally {
            running.set(false)
            runCatching { recorder.stop() }
            recorder.release()
            if (audioRecord === recorder) audioRecord = null
            listener.onCaptureClosed()
        }
        failure?.let(listener::onError)
    }

    private fun readFrame(recorder: AudioRecord): ShortArray? {
        val frame = ShortArray(OnDeviceVoiceModels.WINDOW_SAMPLES)
        var filled = 0
        while (filled < frame.size && running.get()) {
            val count = recorder.read(frame, filled, frame.size - filled, AudioRecord.READ_BLOCKING)
            if (count <= 0) {
                if (running.get()) listener.onError("Microphone recording failed ($count)")
                return null
            }
            filled += count
        }
        return frame.takeIf { filled == frame.size }
    }

    private fun processFrame(frame: ShortArray, probability: Float, state: SegmentState) {
        if (!enrollment && passthrough) {
            processPassthroughFrame(frame, probability)
            return
        }
        val turnEvent = state.turnSegmenter.observe(probability)
        if (turnEvent == VoiceTurnEvent.NONE || turnEvent == VoiceTurnEvent.STARTED) {
            state.preRoll.addLast(frame)
            while (state.preRoll.size > PRE_ROLL_FRAMES) state.preRoll.removeFirst()
            if (turnEvent == VoiceTurnEvent.NONE) return
            state.frames.addAll(state.preRoll)
            state.preRoll.forEach(state::addPending)
            if (!enrollment && verifySpeaker) {
                state.preRoll.takeLast(VoiceTurnSegmenter.START_FRAMES).forEach(state::addSpeakerFrame)
            }
            state.preRoll.clear()
            listener.onSpeechDetected()
            if (!enrollment && !verifySpeaker) {
                state.authorized = true
                listener.onAuthorizedSpeechDetected()
                flushPending(state)
            }
            return
        }

        state.frames += frame
        state.addPending(frame)
        if (!enrollment && verifySpeaker && probability >= SPEAKER_FRAME_PROBABILITY) {
            state.addSpeakerFrame(frame)
        }

        if (!enrollment && !verifySpeaker && state.authorized) {
            flushPending(state)
        } else if (!enrollment && verifySpeaker && state.shouldVerifySpeaker()) {
            val candidate = models.embedding(state.speakerFrames.toList())
            val similarity = candidate?.let { speakerSimilarity(state, it) }
            state.markSpeakerVerified()
            when (state.speakerTracker.observe(similarity)) {
                TargetSpeakerDecision.WAITING -> {
                    // Never starve silently: after several failed measurements
                    // reject the turn out loud so the UI shows why, and count
                    // toward the anchor self-heal below.
                    if (state.verificationAttempts >= WAITING_VERIFICATIONS_TO_REJECT) {
                        registerRejection()
                        listener.onVoiceRejected()
                        state.reset()
                        models.resetVad()
                        return
                    }
                }
                TargetSpeakerDecision.AUTHORIZED -> {
                    state.authorized = true
                    state.targetEmbedding = candidate
                    consecutiveRejections = 0
                    candidate?.let { conversationSpeakerVerifier?.remember(it) }
                    listener.onAuthorizedSpeechDetected()
                    flushPending(state, maxFrames = SPEAKER_WINDOW_FRAMES)
                }
                TargetSpeakerDecision.ACCEPTED -> flushPending(state)
                TargetSpeakerDecision.HOLD -> Unit
                TargetSpeakerDecision.TARGET_ENDED -> {
                    state.pendingFrames.clear()
                    VoiceSemanticEndpoint.finishAfterFilteredBackground(
                        sendAudio = listener::onAuthorizedAudio,
                        commit = listener::onUtteranceCommitted,
                    )
                    state.reset()
                    models.resetVad()
                    return
                }
            }
        }

        if (turnEvent == VoiceTurnEvent.ENDED || state.frames.size >= MAX_SEGMENT_FRAMES) {
            finishSegment(state)
        }
    }

    private fun finishSegment(state: SegmentState) {
        if (enrollment) {
            models.embedding(state.frames)?.let {
                state.enrollmentComplete = true
                listener.onEnrollmentSample(it)
            } ?: listener.onVoiceRejected()
        } else if (state.authorized) {
            flushPending(state)
            listener.onUtteranceCommitted()
        } else {
            val verificationFrames = state.speakerFrames.toList().ifEmpty { state.frames }
            val candidate = models.embedding(verificationFrames)
            val similarity = candidate?.let { conversationSpeakerVerifier?.similarity(it) }
            if (similarity != null && similarity >= TargetSpeakerTracker.AUTHORIZATION_THRESHOLD) {
                consecutiveRejections = 0
                conversationSpeakerVerifier?.remember(candidate)
                listener.onAuthorizedSpeechDetected()
                flushPending(state, maxFrames = SPEAKER_WINDOW_FRAMES)
                listener.onUtteranceCommitted()
            } else {
                registerRejection()
                listener.onVoiceRejected()
            }
        }
        state.reset()
        models.resetVad()
    }

    private var passthroughSpeechFrames = 0
    private var passthroughSpeechNotified = false
    private var passthroughAudibleStreak = 0
    private var passthroughForcedSilence = 0
    private val silentFrame = ShortArray(OnDeviceVoiceModels.WINDOW_SAMPLES)
    private val passthroughPreRoll = ArrayDeque<ShortArray>()
    private var passthroughNoiseGate = VoiceNoiseGate(noiseSensitivity)
    private var passthroughGateActive = false

    // The online model owns delay/state. It may initially return no complete
    // frame; never fill that delay with raw PCM and duplicate it later.
    private fun processPassthroughFrame(frame: ShortArray, rawProbability: Float) {
        if (!noiseFilterEnabled) {
            emitPassthrough(frame, rawProbability, rawProbability)
            return
        }
        // Inference failure goes through capture's explicit error path. Mixing
        // undelayed raw frames into a delayed model stream would corrupt timing.
        val filtered = models.denoise(listOf(frame))
        filtered.frames.forEachIndexed { index, audio ->
            emitPassthrough(audio, filtered.probabilities[index], filtered.probabilities[index])
        }
    }

    private fun emitPassthrough(frame: ShortArray, cleanProbability: Float, rawProbability: Float) {
        val decision = passthroughNoiseGate.observe(cleanProbability)
        listener.onSpeechProbability(decision.probability, decision.openThreshold)
        if (decision.opened || decision.closed) {
            Log.i(
                TAG,
                "voice gate ${if (decision.opened) "opened" else "closed"} " +
                    "mode=${noiseSensitivity.value} p=${"%.3f".format(decision.probability)} " +
                    "floor=${"%.3f".format(decision.noiseFloor)} " +
                    "open=${"%.3f".format(decision.openThreshold)} " +
                    "close=${"%.3f".format(decision.closeThreshold)}",
            )
        }
        if (passthroughForcedSilence > 0) {
            passthroughForcedSilence -= 1
            sendIdentityCheckedFrame(silentFrame, false)
            return
        }
        val audible = if (noiseFilterEnabled) decision.audible else true
        val wasAudible = passthroughGateActive
        passthroughGateActive = audible
        if (!wasAudible) {
            passthroughPreRoll.addLast(frame)
            while (passthroughPreRoll.size > PASSTHROUGH_PRE_ROLL_FRAMES) passthroughPreRoll.removeFirst()
        }
        if (audible) {
            passthroughAudibleStreak += 1
            if (noiseFilterEnabled && passthroughAudibleStreak >= PASSTHROUGH_MAX_UTTERANCE_FRAMES) {
                passthroughAudibleStreak = 0
                passthroughGateActive = false
                passthroughForcedSilence = PASSTHROUGH_FORCED_SILENCE_FRAMES
            }
        } else {
            passthroughAudibleStreak = 0
        }
        val outgoing = when {
            !audible -> listOf(silentFrame)
            !wasAudible && passthroughPreRoll.isNotEmpty() -> passthroughPreRoll.toList().also {
                passthroughPreRoll.clear()
            }
            else -> listOf(frame)
        }
        if (streamingSpeakerGate != null) {
            // Keep the VAD hangover and onset pre-roll; per-frame hard clipping
            // would remove quiet consonants and worsen ASR. Identity still uses
            // the VAD when the user disables denoising.
            outgoing.forEach { sendIdentityCheckedFrame(it, decision.audible) }
        } else {
            listener.onSpeechGate(audible)
            listener.onAuthorizedAudio(toPcm16(outgoing))
            trackPassthroughBargeIn(if (noiseFilterEnabled) audible else rawProbability >= SPEAKER_FRAME_PROBABILITY)
        }
    }

    private fun sendIdentityCheckedFrame(frame: ShortArray, speech: Boolean) {
        val gate = streamingSpeakerGate
        if (gate == null) {
            listener.onSpeechGate(speech)
            listener.onAuthorizedAudio(toPcm16(listOf(frame)))
            trackPassthroughBargeIn(speech)
            return
        }
        val result = gate.accept(frame, speech)
        check(!result.unavailable) { SPEAKER_MODEL_UNAVAILABLE }
        if (result.authorized) {
            if (!streamingSpeakerAccepted) listener.onAuthorizedSpeechDetected()
            streamingSpeakerAccepted = true
            streamingSpeakerRejected = false
            verifiedPlayback.addAll(result.audio)
        } else if (result.rejected) {
            if (!streamingSpeakerRejected) listener.onVoiceRejected()
            streamingSpeakerRejected = true
            streamingSpeakerAccepted = false
        }
        if (!speech) streamingSpeakerAccepted = false
        // Pace verified PCM at capture rate, not a burst + another second of
        // silence per window. This is a bounded delay, not growing stream time.
        val output = if (verifiedPlayback.isEmpty()) null else verifiedPlayback.removeFirst()
        listener.onSpeechGate(output != null)
        listener.onAuthorizedAudio(toPcm16(listOf(output ?: silentFrame)))
    }

    private fun trackPassthroughBargeIn(audible: Boolean) {
        if (audible) {
            passthroughSpeechFrames += 1
            if (!passthroughSpeechNotified && passthroughSpeechFrames >= PASSTHROUGH_BARGE_IN_FRAMES) {
                passthroughSpeechNotified = true
                listener.onAuthorizedSpeechDetected()
            }
        } else {
            passthroughSpeechFrames = 0
            passthroughSpeechNotified = false
        }
    }

    private fun speakerSimilarity(state: SegmentState, candidate: FloatArray): Float {
        val conversationSimilarity = requireNotNull(conversationSpeakerVerifier).similarity(candidate)
        val anchor = state.targetEmbedding ?: return conversationSimilarity
        val anchorSimilarity = VoiceEmbedding.similarity(anchor, candidate)
        return anchorSimilarity * TARGET_ANCHOR_WEIGHT + conversationSimilarity * CONVERSATION_IDENTITY_WEIGHT
    }

    private fun flushPending(state: SegmentState, maxFrames: Int? = null) {
        if (state.pendingFrames.isEmpty()) return
        val pending = state.pendingFrames.toList()
        val frames = maxFrames?.let(pending::takeLast) ?: pending
        listener.onAuthorizedAudio(toPcm16(frames))
        state.pendingFrames.clear()
    }

    private fun level(frame: ShortArray): Float {
        val meanSquare = frame.sumOf { sample -> sample.toDouble() * sample.toDouble() } / frame.size
        return (sqrt(meanSquare) / 6_000.0).toFloat().coerceIn(0f, 1f)
    }

    private fun toPcm16(frames: List<ShortArray>): ByteArray {
        val out = ByteArray(frames.sumOf { it.size } * 2)
        var offset = 0
        frames.forEach { frame ->
            frame.forEach { sample ->
                out[offset++] = (sample.toInt() and 0xff).toByte()
                out[offset++] = (sample.toInt() shr 8 and 0xff).toByte()
            }
        }
        return out
    }

    private class SegmentState {
        val turnSegmenter = VoiceTurnSegmenter()
        val speakerTracker = TargetSpeakerTracker()
        val preRoll = ArrayDeque<ShortArray>()
        val pendingFrames = ArrayDeque<ShortArray>()
        val speakerFrames = ArrayDeque<ShortArray>()
        val frames = mutableListOf<ShortArray>()
        var authorized = false
        var targetEmbedding: FloatArray? = null
        var speakerFramesSinceVerification = 0
        var hasSpeakerMeasurement = false
        var verificationAttempts = 0
        var enrollmentComplete = false

        fun addPending(frame: ShortArray) {
            pendingFrames.addLast(frame)
            while (pendingFrames.size > MAX_PENDING_FRAMES) pendingFrames.removeFirst()
        }

        fun addSpeakerFrame(frame: ShortArray) {
            speakerFrames.addLast(frame)
            while (speakerFrames.size > SPEAKER_WINDOW_FRAMES) speakerFrames.removeFirst()
            speakerFramesSinceVerification += 1
        }

        fun shouldVerifySpeaker(): Boolean {
            if (speakerFrames.size < INITIAL_SPEAKER_VERIFICATION_FRAMES) return false
            val requiredFrames = if (hasSpeakerMeasurement) {
                VERIFICATION_RETRY_FRAMES
            } else {
                INITIAL_SPEAKER_VERIFICATION_FRAMES
            }
            return speakerFramesSinceVerification >= requiredFrames
        }

        fun markSpeakerVerified() {
            hasSpeakerMeasurement = true
            speakerFramesSinceVerification = 0
            verificationAttempts += 1
        }

        fun reset() {
            preRoll.clear()
            pendingFrames.clear()
            speakerFrames.clear()
            frames.clear()
            turnSegmenter.reset()
            speakerTracker.reset()
            authorized = false
            targetEmbedding = null
            speakerFramesSinceVerification = 0
            hasSpeakerMeasurement = false
            verificationAttempts = 0
        }
    }


    companion object {
        private const val TAG = "TermbridgeVoice"
        const val SPEAKER_MODEL_UNAVAILABLE = "speaker_model_unavailable"
        const val PRE_ROLL_FRAMES = 10
        // First decision after 12 speech frames (384 ms); ambiguous voices keep
        // accumulating toward the full 1.2 s rolling CAM++ window.
        const val INITIAL_SPEAKER_VERIFICATION_FRAMES = 12
        const val SPEAKER_WINDOW_FRAMES = 38
        const val VERIFICATION_RETRY_FRAMES = 8
        const val MAX_PENDING_FRAMES = 64
        const val MAX_SEGMENT_FRAMES = 625
        const val SPEAKER_FRAME_PROBABILITY = 0.50f
        const val TARGET_ANCHOR_WEIGHT = 0.75f
        const val CONVERSATION_IDENTITY_WEIGHT = 0.25f
        const val WAITING_VERIFICATIONS_TO_REJECT = 3
        const val REJECTIONS_TO_RESET_ANCHOR = 2
        // ~192 ms of confident speech interrupts assistant playback.
        const val PASSTHROUGH_BARGE_IN_FRAMES = 6
        const val PASSTHROUGH_PRE_ROLL_FRAMES = 10
        // 10 s of uninterrupted "speech" forces a boundary…
        const val PASSTHROUGH_MAX_UTTERANCE_FRAMES = 312
        // …of 2 s digital silence, comfortably above the backend's 1.4 s VAD.
        const val PASSTHROUGH_FORCED_SILENCE_FRAMES = 63
    }
}
