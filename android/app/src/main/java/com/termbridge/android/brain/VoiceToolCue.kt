package com.termbridge.android.brain

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioTrack
import java.util.concurrent.Executors
import kotlin.math.PI
import kotlin.math.exp
import kotlin.math.sin

/** Original, locally synthesized earcons for realtime tool activity and Agent completion. */
class VoiceToolCue : AutoCloseable {
    private val lock = Any()
    private val activityExecutor = Executors.newSingleThreadExecutor()
    private val notificationExecutor = Executors.newSingleThreadExecutor()
    private var activityTrack: AudioTrack? = null
    private var activityGeneration = 0
    @Volatile private var closed = false

    /** Starts a quiet, continuously varying pulse. Calling it again replaces the previous loop. */
    fun startActivity() {
        val generation = synchronized(lock) {
            if (closed) return
            activityGeneration += 1
            activityGeneration
        }
        activityExecutor.execute {
            val track = createTrack(generateActivityPcm()) ?: return@execute
            if (track.setLoopPoints(0, ACTIVITY_SAMPLE_COUNT, -1) != AudioTrack.SUCCESS) {
                track.release()
                return@execute
            }
            val shouldPlay = synchronized(lock) {
                if (closed || generation != activityGeneration) {
                    false
                } else {
                    releaseActivityLocked()
                    activityTrack = track
                    track.play()
                    true
                }
            }
            if (!shouldPlay) {
                track.release()
            }
        }
    }

    fun stopActivity() {
        synchronized(lock) {
            if (closed) return
            activityGeneration += 1
        }
        activityExecutor.execute {
            synchronized(lock) { releaseActivityLocked() }
        }
    }

    /** A single soft ascending chime for an asynchronous Agent completion. */
    fun playNotification() {
        if (closed) return
        notificationExecutor.execute {
            if (closed) return@execute
            val track = createTrack(generateNotificationPcm()) ?: return@execute
            track.play()
            runCatching { Thread.sleep(NOTIFICATION_DURATION_MS.toLong() + RELEASE_GRACE_MS) }
            runCatching { track.stop() }
            track.release()
        }
    }

    override fun close() {
        synchronized(lock) {
            closed = true
            activityGeneration += 1
            releaseActivityLocked()
        }
        activityExecutor.shutdownNow()
        notificationExecutor.shutdownNow()
    }

    private fun releaseActivityLocked() {
        val current = activityTrack ?: return
        activityTrack = null
        runCatching { current.stop() }
        current.release()
    }

    private fun createTrack(pcm: ShortArray): AudioTrack? {
        val track = AudioTrack(
            AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build(),
            AudioFormat.Builder()
                .setSampleRate(SAMPLE_RATE)
                .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                .build(),
            pcm.size * Short.SIZE_BYTES,
            AudioTrack.MODE_STATIC,
            AudioManager.AUDIO_SESSION_ID_GENERATE,
        )
        if (track.state != AudioTrack.STATE_INITIALIZED) {
            track.release()
            return null
        }
        if (track.write(pcm, 0, pcm.size) != pcm.size) {
            track.release()
            return null
        }
        return track
    }

    internal companion object {
        const val SAMPLE_RATE = 24_000
        const val ACTIVITY_DURATION_MS = 2_400
        const val NOTIFICATION_DURATION_MS = 680
        private const val RELEASE_GRACE_MS = 50L
        private const val ACTIVITY_SAMPLE_COUNT = SAMPLE_RATE * ACTIVITY_DURATION_MS / 1_000

        fun generateActivityPcm(): ShortArray {
            val samples = ShortArray(ACTIVITY_SAMPLE_COUNT)
            for (index in samples.indices) {
                val phase = 2.0 * PI * index / samples.size
                val pulse = 0.34 + 0.18 * (1.0 + sin(phase - 0.7)) +
                    0.14 * (1.0 + sin(phase * 3.0 + 1.4))
                val low = sin(phase * 504.0 + 0.34 * sin(phase * 2.0))
                val middle = sin(phase * 756.0 - 0.27 * sin(phase * 3.0 + 0.4))
                val shimmer = sin(phase * 1_056.0 + 0.22 * sin(phase * 5.0))
                val value = (low * 0.52 + middle * 0.31 + shimmer * 0.17) * pulse * 0.055
                samples[index] = (value * Short.MAX_VALUE).toInt()
                    .coerceIn(Short.MIN_VALUE.toInt(), Short.MAX_VALUE.toInt())
                    .toShort()
            }
            return samples
        }

        fun generateNotificationPcm(): ShortArray {
            val samples = ShortArray(SAMPLE_RATE * NOTIFICATION_DURATION_MS / 1_000)
            addBell(samples, startMs = 0, durationMs = 430, frequencyHz = 783.99, gain = 0.16)
            addBell(samples, startMs = 145, durationMs = 520, frequencyHz = 1_046.50, gain = 0.14)
            return samples
        }

        private fun addBell(
            samples: ShortArray,
            startMs: Int,
            durationMs: Int,
            frequencyHz: Double,
            gain: Double,
        ) {
            val start = SAMPLE_RATE * startMs / 1_000
            val count = minOf(SAMPLE_RATE * durationMs / 1_000, samples.size - start)
            for (index in 0 until count) {
                val progress = index.toDouble() / count
                val attack = (index / (SAMPLE_RATE * 0.014)).coerceIn(0.0, 1.0)
                val release = exp(-5.2 * progress)
                val fundamental = sin(2.0 * PI * frequencyHz * index / SAMPLE_RATE)
                val overtone = sin(2.0 * PI * frequencyHz * 2.01 * index / SAMPLE_RATE) * 0.18
                val value = (fundamental + overtone) * attack * release * gain
                val mixed = samples[start + index] + (value * Short.MAX_VALUE).toInt()
                samples[start + index] = mixed.coerceIn(
                    Short.MIN_VALUE.toInt(),
                    Short.MAX_VALUE.toInt(),
                ).toShort()
            }
        }
    }
}
