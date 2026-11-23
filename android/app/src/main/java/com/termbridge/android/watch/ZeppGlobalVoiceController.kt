package com.termbridge.android.watch

import android.content.Context
import android.util.Log
import com.termbridge.android.protocol.ControlMessage
import io.github.jaredmdobson.concentus.OpusDecoder
import io.github.jaredmdobson.concentus.OpusPacketInfo
import java.io.ByteArrayOutputStream
import java.io.Closeable
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.UUID
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/**
 * Turns a short Zepp OS Opus recording into one Global turn.
 *
 * The watch never receives the Host credential. Its recording reaches this
 * controller through the authenticated loopback bridge, is decoded locally,
 * and then uses ASR and Global messages. Results return as text receipts only:
 * this background bridge has no visible call surface or phone playback lease.
 */
class ZeppGlobalVoiceController(
    context: Context,
    private val isHostReady: () -> Boolean,
    private val sendControl: (List<Pair<String, Any?>>) -> Boolean,
    private val shouldConfirmBeforeSend: () -> Boolean = { true },
    private val onReceipt: (ZeppVoiceSnapshot, String?) -> Unit = { _, _ -> },
    private val now: () -> Long = System::currentTimeMillis,
    private val decoder: (Context, ByteArray) -> ByteArray = ZeppOpusDecoder::decodeToPcm16Mono16k,
) : Closeable {
    private val appContext = context.applicationContext
    private val worker: ExecutorService = Executors.newSingleThreadExecutor { task ->
        Thread(task, "termbridge-zepp-voice").apply { isDaemon = true }
    }

    private var current: VoiceTurn? = null

    @Synchronized
    fun submit(opus: ByteArray, sourceSessionId: String? = null): ZeppVoiceSnapshot {
        expireLocked()
        require(opus.size in MIN_OPUS_BYTES..MAX_OPUS_BYTES) { "invalid_audio" }
        if (!isHostReady()) throw VoiceUnavailableException("global_offline")
        if (current?.snapshot?.terminal == false) throw VoiceBusyException()

        val id = UUID.randomUUID().toString()
        val timestamp = now()
        val turn = VoiceTurn(
            snapshot = ZeppVoiceSnapshot(id, STATE_DECODING, "", "", "", timestamp),
            transcriptionId = "$id-asr",
            brainRequestId = "$id-global",
            synthesisId = "$id-tts",
            sourceSessionId = sourceSessionId?.trim()?.takeIf(String::isNotEmpty)?.take(MAX_SOURCE_SESSION_ID_CHARS),
        )
        current = turn
        Log.i(LOG_TAG, "voice turn queued; opusBytes=${opus.size}")
        worker.execute { decodeAndTranscribe(turn, opus.copyOf()) }
        return turn.snapshot
    }

    @Synchronized
    fun snapshot(id: String): ZeppVoiceSnapshot? {
        expireLocked()
        return current?.takeIf { it.snapshot.id == id }?.snapshot
    }

    fun decide(id: String, decision: ZeppVoiceDecision): ZeppVoiceSnapshot? {
        val turn = synchronized(this) {
            expireLocked()
            current?.takeIf { it.snapshot.id == id }?.also {
                if (it.snapshot.state != STATE_AWAITING_CONFIRMATION) throw VoiceDecisionException("invalid_state")
                it.snapshot = it.snapshot.copy(
                    state = when (decision) {
                        ZeppVoiceDecision.CONFIRM -> STATE_THINKING
                        ZeppVoiceDecision.REWRITE -> STATE_REWRITE
                        ZeppVoiceDecision.DISCARD -> STATE_DISCARDED
                    },
                    updatedAt = now(),
                )
            }
        } ?: return null

        if (decision == ZeppVoiceDecision.CONFIRM) dispatchToGlobal(turn)
        return synchronized(this) { turn.snapshot }
    }

    @Synchronized
    fun onHostUnavailable() {
        current?.takeIf { !it.snapshot.terminal }?.let { turn ->
            turn.snapshot = turn.snapshot.copy(state = STATE_ERROR, error = "global_offline", updatedAt = now())
            publishReceiptLocked(turn)
        }
    }

    fun handle(message: ControlMessage): Boolean {
        val turn = synchronized(this) { current } ?: return false
        return when (message.type) {
            "brain_transcribe_result" -> handleTranscription(turn, message)
            "brain_accepted" -> message.string("requestId") == turn.brainRequestId
            "brain_execution_event" -> handleExecutionEvent(turn, message)
            "brain_snapshot_result" -> handleBrainSnapshot(turn, message)
            // Ignore obsolete replies from older app versions. This watch bridge has no
            // visible call surface or audio lease, so it must never start phone playback.
            "brain_synthesize_result" -> message.string("requestId") == turn.synthesisId
            else -> false
        }
    }

    private fun decodeAndTranscribe(turn: VoiceTurn, opus: ByteArray) {
        val pcm = runCatching { decoder(appContext, opus) }.getOrElse { error ->
            val prefix = opus.take(DIAGNOSTIC_PREFIX_BYTES).joinToString("") { byte ->
                "%02x".format(byte.toInt() and 0xff)
            }
            Log.e(LOG_TAG, "watch audio decode failed; encodedBytes=${opus.size}; prefix=$prefix", error)
            fail(turn, "audio_decode_failed")
            return
        }
        if (pcm.size !in MIN_PCM_BYTES..MAX_PCM_BYTES || pcm.size % 2 != 0) {
            fail(turn, "audio_decode_failed")
            return
        }
        Log.i(LOG_TAG, "watch audio decoded; pcmBytes=${pcm.size}")
        synchronized(this) {
            if (current !== turn || turn.snapshot.terminal) return
            turn.snapshot = turn.snapshot.copy(state = STATE_TRANSCRIBING, updatedAt = now())
        }
        if (!send(
                "t" to "brain_transcribe_start",
                "requestId" to turn.transcriptionId,
                "locale" to "zh-CN",
            )
        ) {
            fail(turn, "global_offline")
            return
        }
        var offset = 0
        while (offset < pcm.size) {
            val size = minOf(PCM_CHUNK_BYTES, pcm.size - offset)
            if (!send(
                    "t" to "brain_transcribe_audio",
                    "requestId" to turn.transcriptionId,
                    "data" to pcm.copyOfRange(offset, offset + size),
                )
            ) {
                fail(turn, "global_offline")
                return
            }
            offset += size
        }
        if (!send("t" to "brain_transcribe_commit", "requestId" to turn.transcriptionId)) {
            fail(turn, "global_offline")
        }
    }

    private fun handleTranscription(turn: VoiceTurn, message: ControlMessage): Boolean {
        if (message.string("requestId") != turn.transcriptionId) return false
        message.string("error")?.takeIf(String::isNotBlank)?.let {
            send("t" to "brain_transcribe_finish", "requestId" to turn.transcriptionId)
            fail(turn, "transcription_failed")
            return true
        }
        val text = message.string("text")?.trim().orEmpty()
        if (text.isNotEmpty()) synchronized(this) {
            if (current === turn && !turn.snapshot.terminal) {
                turn.snapshot = turn.snapshot.copy(transcript = text.take(MAX_TEXT_CHARS), updatedAt = now())
            }
        }
        if (message.boolean("final") != true) return true
        Log.i(LOG_TAG, "watch transcript completed")
        send("t" to "brain_transcribe_finish", "requestId" to turn.transcriptionId)
        if (text.isBlank()) {
            fail(turn, "no_speech")
            return true
        }
        val needsConfirmation = runCatching(shouldConfirmBeforeSend).getOrDefault(true)
        synchronized(this) {
            if (current !== turn || turn.snapshot.terminal) return true
            turn.snapshot = turn.snapshot.copy(
                state = if (needsConfirmation) STATE_AWAITING_CONFIRMATION else STATE_THINKING,
                transcript = text.take(MAX_TEXT_CHARS),
                updatedAt = now(),
            )
        }
        if (!needsConfirmation) dispatchToGlobal(turn)
        return true
    }

    private fun dispatchToGlobal(turn: VoiceTurn) {
        val text = synchronized(this) {
            if (current !== turn || turn.snapshot.terminal) return
            turn.snapshot.transcript
        }
        val fields = mutableListOf<Pair<String, Any?>>(
            "t" to "brain_send",
            "requestId" to turn.brainRequestId,
            "text" to text,
            "clientPlatform" to "zepp-watch-voice",
        )
        turn.sourceSessionId?.let { fields += "sourceSessionId" to it }
        if (!sendControl(fields)) fail(turn, "global_offline")
    }

    private fun handleExecutionEvent(turn: VoiceTurn, message: ControlMessage): Boolean {
        val event = message.brainExecutionEvent() ?: return false
        if (event.requestId != turn.brainRequestId) return false
        when (event.phase) {
            "fork_failed" -> fail(turn, "global_failed")
            "fork_completed" -> send("t" to "brain_snapshot")
        }
        return true
    }

    private fun handleBrainSnapshot(turn: VoiceTurn, message: ControlMessage): Boolean {
        val answer = message.brainMessages().lastOrNull {
            it.id == "${turn.brainRequestId}-brain" && it.role == "brain"
        } ?: return false
        val reply = answer.text.trim().take(MAX_TEXT_CHARS)
        if (reply.isBlank()) {
            fail(turn, "global_failed")
            return true
        }
        synchronized(this) {
            if (current !== turn || turn.snapshot.terminal || turn.snapshot.reply.isNotBlank()) return@synchronized false
            turn.snapshot = turn.snapshot.copy(state = STATE_DONE, reply = reply, updatedAt = now())
            publishReceiptLocked(turn)
            Log.i(LOG_TAG, "Global text answer delivered; no phone playback; chars=${reply.length}")
        }
        return true
    }

    private fun fail(turn: VoiceTurn, error: String) {
        synchronized(this) {
            if (current !== turn || turn.snapshot.terminal) return
            turn.snapshot = turn.snapshot.copy(state = STATE_ERROR, error = error, updatedAt = now())
            publishReceiptLocked(turn)
        }
        Log.w(LOG_TAG, "voice turn failed: $error")
    }

    private fun publishReceiptLocked(turn: VoiceTurn) {
        if (!turn.snapshot.terminal || turn.receiptReported) return
        turn.receiptReported = true
        onReceipt(turn.snapshot, turn.sourceSessionId)
    }

    private fun send(vararg fields: Pair<String, Any?>): Boolean = sendControl(fields.toList())

    @Synchronized
    private fun expireLocked() {
        current?.takeIf { !it.snapshot.terminal && now() - it.snapshot.updatedAt > TURN_TIMEOUT_MS }?.let { turn ->
            turn.snapshot = turn.snapshot.copy(state = STATE_ERROR, error = "timeout", updatedAt = now())
            publishReceiptLocked(turn)
        }
    }

    override fun close() {
        worker.shutdownNow()
    }

    private data class VoiceTurn(
        var snapshot: ZeppVoiceSnapshot,
        val transcriptionId: String,
        val brainRequestId: String,
        val synthesisId: String,
        val sourceSessionId: String?,
        var receiptReported: Boolean = false,
    )

    companion object {
        const val STATE_DECODING = "decoding"
        const val STATE_TRANSCRIBING = "transcribing"
        const val STATE_AWAITING_CONFIRMATION = "awaiting_confirmation"
        const val STATE_THINKING = "thinking"
        const val STATE_SYNTHESIZING = "synthesizing"
        const val STATE_SPEAKING = "speaking"
        const val STATE_DONE = "done"
        const val STATE_ERROR = "error"
        const val STATE_REWRITE = "rewrite"
        const val STATE_DISCARDED = "discarded"

        private const val MIN_OPUS_BYTES = 64
        private const val MAX_OPUS_BYTES = 1_000_000
        private const val MIN_PCM_BYTES = 1_600
        private const val MAX_PCM_BYTES = 16_000 * 2 * 30
        private const val PCM_CHUNK_BYTES = 32 * 1024
        private const val MAX_TEXT_CHARS = 2_000
        private const val MAX_SOURCE_SESSION_ID_CHARS = 256
        private const val DIAGNOSTIC_PREFIX_BYTES = 32
        private const val TURN_TIMEOUT_MS = 120_000L
        private const val LOG_TAG = "ZeppVoice"
    }
}

class VoiceBusyException : IllegalStateException("voice_busy")
class VoiceUnavailableException(message: String) : IllegalStateException(message)
class VoiceDecisionException(message: String) : IllegalStateException(message)

enum class ZeppVoiceDecision(val wireName: String) {
    CONFIRM("confirm"),
    REWRITE("rewrite"),
    DISCARD("discard");

    companion object {
        fun fromWireName(value: String): ZeppVoiceDecision? = entries.firstOrNull { it.wireName == value }
    }
}

data class ZeppVoiceSnapshot(
    val id: String,
    val state: String,
    val transcript: String,
    val reply: String,
    val error: String,
    val updatedAt: Long,
) {
    val terminal: Boolean get() = state in setOf(
        ZeppGlobalVoiceController.STATE_DONE,
        ZeppGlobalVoiceController.STATE_ERROR,
        ZeppGlobalVoiceController.STATE_REWRITE,
        ZeppGlobalVoiceController.STATE_DISCARDED,
    )

    fun toJson(): String = buildString {
        append("{\"version\":1,\"voiceId\":").append(id.jsonQuoted())
        append(",\"state\":").append(state.jsonQuoted())
        append(",\"transcript\":").append(transcript.jsonQuoted())
        append(",\"reply\":").append(reply.jsonQuoted())
        append(",\"error\":").append(error.jsonQuoted())
        append(",\"updatedAt\":").append(updatedAt.coerceAtLeast(0L)).append('}')
    }
}

internal object ZeppOpusDecoder {
    @Suppress("UNUSED_PARAMETER")
    fun decodeToPcm16Mono16k(context: Context, encoded: ByteArray): ByteArray = decodeFrames(encoded)

    internal fun decodeFrames(encoded: ByteArray): ByteArray {
        val decoder = OpusDecoder(TARGET_SAMPLE_RATE, TARGET_CHANNELS)
        val output = ByteArrayOutputStream()
        for (range in frameRanges(encoded, allowTrailingGarbage = true)) {
            val packetLength = range.last - range.first + 1
            val sampleCount = OpusPacketInfo.getNumSamples(decoder, encoded, range.first, packetLength)
            require(sampleCount in 1..MAX_FRAME_SAMPLES) { "Invalid Opus frame duration" }
            val pcm = ShortArray(sampleCount)
            val decodedSamples = decoder.decode(
                encoded,
                range.first,
                packetLength,
                pcm,
                0,
                sampleCount,
                false,
            )
            require(decodedSamples in 1..sampleCount) { "Opus frame produced no audio" }
            repeat(decodedSamples) { index ->
                val sample = pcm[index].toInt()
                output.write(sample and 0xff)
                output.write(sample ushr 8 and 0xff)
            }
            require(output.size() <= MAX_DECODED_BYTES) { "Decoded audio is too large" }
        }
        return output.toByteArray()
    }

    /**
     * Zepp Recorder output is not an Ogg/Opus file. Each raw Opus packet is
     * wrapped in an eight-byte Zepp envelope: a big-endian uint32 payload
     * length, four bytes of metadata, then the payload itself.
     */
    internal fun frameRanges(encoded: ByteArray, allowTrailingGarbage: Boolean = false): List<IntRange> {
        val ranges = mutableListOf<IntRange>()
        var position = 0
        while (position < encoded.size) {
            if (encoded.size - position < FRAME_HEADER_BYTES) {
                if (allowTrailingGarbage && ranges.isNotEmpty()) break
                throw IllegalArgumentException("Truncated Zepp Opus frame header")
            }
            val packetLength =
                ((encoded[position].toLong() and 0xff) shl 24) or
                    ((encoded[position + 1].toLong() and 0xff) shl 16) or
                    ((encoded[position + 2].toLong() and 0xff) shl 8) or
                    (encoded[position + 3].toLong() and 0xff)
            if (packetLength !in 1..MAX_PACKET_BYTES.toLong()) {
                if (allowTrailingGarbage && ranges.isNotEmpty()) break
                throw IllegalArgumentException(
                    "Invalid Zepp Opus packet length at offset=$position length=$packetLength remaining=${encoded.size - position}",
                )
            }
            val payloadStart = position + FRAME_HEADER_BYTES
            val payloadEnd = payloadStart + packetLength.toInt()
            if (payloadEnd > encoded.size) {
                if (allowTrailingGarbage && ranges.isNotEmpty()) break
                throw IllegalArgumentException(
                    "Truncated Zepp Opus packet at offset=$position length=$packetLength remaining=${encoded.size - position}",
                )
            }
            ranges += payloadStart until payloadEnd
            position = payloadEnd
        }
        require(ranges.isNotEmpty()) { "No Zepp Opus frames" }
        return ranges
    }

    internal fun normalizePcm16(input: ByteArray, sampleRate: Int, channels: Int): ByteArray {
        require(sampleRate in 8_000..192_000 && channels in 1..8 && input.size % (2 * channels) == 0)
        val frames = input.size / (2 * channels)
        if (frames == 0) return ByteArray(0)
        val mono = ShortArray(frames)
        val source = ByteBuffer.wrap(input).order(ByteOrder.LITTLE_ENDIAN)
        for (frame in 0 until frames) {
            var sum = 0L
            repeat(channels) { sum += source.short.toLong() }
            mono[frame] = (sum / channels).coerceIn(Short.MIN_VALUE.toLong(), Short.MAX_VALUE.toLong()).toInt().toShort()
        }
        val outputFrames = ((frames.toLong() * TARGET_SAMPLE_RATE) / sampleRate).toInt().coerceAtLeast(1)
        val result = ByteBuffer.allocate(outputFrames * 2).order(ByteOrder.LITTLE_ENDIAN)
        for (index in 0 until outputFrames) {
            val position = index.toDouble() * sampleRate / TARGET_SAMPLE_RATE
            val left = position.toInt().coerceIn(0, frames - 1)
            val right = (left + 1).coerceAtMost(frames - 1)
            val fraction = position - left
            val sample = mono[left] + (mono[right] - mono[left]) * fraction
            result.putShort(sample.toInt().coerceIn(Short.MIN_VALUE.toInt(), Short.MAX_VALUE.toInt()).toShort())
        }
        return result.array()
    }

    private const val TARGET_SAMPLE_RATE = 16_000
    private const val TARGET_CHANNELS = 1
    private const val FRAME_HEADER_BYTES = 8
    private const val MAX_PACKET_BYTES = 16 * 1024
    private const val MAX_FRAME_SAMPLES = TARGET_SAMPLE_RATE * 120 / 1_000
    private const val MAX_DECODED_BYTES = TARGET_SAMPLE_RATE * 2 * 30
}
