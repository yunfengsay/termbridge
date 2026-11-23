package com.termbridge.android.brain

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioTrack
import android.media.PlaybackParams
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.atomic.AtomicBoolean

/** Small streaming PCM player whose AudioTrack is owned exclusively by the playback thread. */
class RealtimePcmPlayer(
    initialPlaybackRate: Float,
    private val onStarted: () -> Unit,
    private val onDrained: () -> Unit,
) : AutoCloseable {
    private sealed interface Packet {
        data class Audio(val bytes: ByteArray, val sampleRate: Int, val generation: Long) : Packet
        data class End(val generation: Long) : Packet
        data object Interrupt : Packet
        data object Close : Packet
    }

    private val queue = LinkedBlockingQueue<Packet>(MAX_PACKETS)
    private val queueLock = Any()
    private val rateChanged = AtomicBoolean(false)
    @Volatile private var playbackRate = VoiceSettingsStore.normalizePlaybackRate(initialPlaybackRate)
    @Volatile private var closed = false
    @Volatile private var generation = 0L
    @Volatile private var outputPending = false
    @Volatile private var verificationMuted = false
    @Volatile private var track: AudioTrack? = null
    private var started = false
    private val worker = Thread(::playLoop, "termbridge-realtime-pcm").apply { start() }

    fun enqueue(bytes: ByteArray, sampleRate: Int): Boolean = synchronized(queueLock) {
        if (closed || bytes.isEmpty() || bytes.size % 2 != 0) return@synchronized false
        queue.offer(Packet.Audio(bytes.copyOf(), sampleRate, generation)).also { accepted ->
            if (accepted) outputPending = true
        }
    }

    fun hasPendingOutput(): Boolean = outputPending

    /** Immediately silences playback while local speaker verification is still pending. */
    fun muteForVerification() {
        verificationMuted = true
        track?.let { runCatching { it.setVolume(0f) } }
    }

    /** Restores playback when a potential interruption was rejected as another speaker or noise. */
    fun resumeAfterRejectedSpeech() {
        verificationMuted = false
        track?.let { runCatching { it.setVolume(1f) } }
    }

    fun finishResponse() = synchronized(queueLock) {
        if (!closed) queue.offer(Packet.End(generation))
        Unit
    }

    fun setPlaybackRate(rate: Float) {
        playbackRate = VoiceSettingsStore.normalizePlaybackRate(rate)
        rateChanged.set(true)
    }

    /** Drops buffered audio without touching AudioTrack from the caller thread. */
    fun interrupt() = synchronized(queueLock) {
        if (closed) return@synchronized
        generation += 1
        outputPending = false
        verificationMuted = false
        // Silence already-written hardware buffers immediately; the worker
        // will release the track after its current bounded write returns.
        track?.let { runCatching { it.setVolume(0f) } }
        queue.clear()
        queue.offer(Packet.Interrupt)
    }

    override fun close() {
        synchronized(queueLock) {
            if (closed) return
            closed = true
            generation += 1
            outputPending = false
            verificationMuted = false
            track?.let { runCatching { it.setVolume(0f) } }
            queue.clear()
            queue.offer(Packet.Close)
        }
        runCatching { worker.join(CLOSE_JOIN_MS) }
        if (worker.isAlive) worker.interrupt()
    }

    private fun playLoop() {
        try {
            while (true) {
                when (val packet = queue.take()) {
                    is Packet.Audio -> write(packet)
                    is Packet.End -> if (packet.generation == generation) {
                        outputPending = false
                        started = false
                        onDrained()
                    }
                    Packet.Interrupt -> resetTrack()
                    Packet.Close -> return
                }
            }
        } catch (_: InterruptedException) {
            // close() only interrupts after the orderly shutdown deadline.
        } finally {
            releaseTrack()
        }
    }

    private fun write(packet: Packet.Audio) {
        if (packet.generation != generation) return
        val output = ensureTrack(packet.sampleRate) ?: return
        if (!started) {
            started = true
            onStarted()
        }
        var offset = 0
        while (!closed && packet.generation == generation && offset < packet.bytes.size) {
            if (rateChanged.getAndSet(false)) applyPlaybackRate(output)
            val size = minOf(WRITE_CHUNK_BYTES, packet.bytes.size - offset)
            val written = runCatching {
                output.write(packet.bytes, offset, size, AudioTrack.WRITE_BLOCKING)
            }.getOrElse { return }
            if (written <= 0) return
            offset += written
        }
    }

    private fun ensureTrack(sampleRate: Int): AudioTrack? {
        track?.takeIf { it.sampleRate == sampleRate }?.let { return it }
        releaseTrack()
        val minimum = AudioTrack.getMinBufferSize(
            sampleRate,
            AudioFormat.CHANNEL_OUT_MONO,
            AudioFormat.ENCODING_PCM_16BIT,
        )
        if (minimum <= 0) return null
        val created = AudioTrack(
            AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                .build(),
            AudioFormat.Builder()
                .setSampleRate(sampleRate)
                .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                .build(),
            minimum * 4,
            AudioTrack.MODE_STREAM,
            AudioManager.AUDIO_SESSION_ID_GENERATE,
        )
        if (created.state != AudioTrack.STATE_INITIALIZED) {
            created.release()
            return null
        }
        applyPlaybackRate(created)
        created.setVolume(if (verificationMuted) 0f else 1f)
        created.play()
        track = created
        return created
    }

    private fun resetTrack() {
        started = false
        releaseTrack()
    }

    private fun releaseTrack() {
        track?.let {
            runCatching { it.stop() }
            runCatching { it.release() }
        }
        track = null
    }

    private fun applyPlaybackRate(output: AudioTrack) {
        runCatching {
            output.playbackParams = PlaybackParams()
                .setSpeed(playbackRate)
                .setPitch(1f)
                .setAudioFallbackMode(PlaybackParams.AUDIO_FALLBACK_MODE_DEFAULT)
        }
    }

    private companion object {
        const val MAX_PACKETS = 256
        // Keep a blocking write short so local barge-in can flush playback promptly.
        const val WRITE_CHUNK_BYTES = 1_024
        const val CLOSE_JOIN_MS = 1_000L
    }
}
