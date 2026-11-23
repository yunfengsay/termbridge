package com.termbridge.android.brain

import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/** Bounded latest-window inference. Slow inference never queues unbounded PCM or blocks AudioRecord. */
class LocalBoundaryAudioMonitor(
    private val createDecoder: () -> LocalBoundarySpeechDecoder,
    private val onTranscript: (Long, String) -> Unit,
    private val onError: (Throwable) -> Unit,
) : AutoCloseable {
    private val executor = Executors.newSingleThreadExecutor { task -> Thread(task, "tb-local-boundary") }
    private val closed = AtomicBoolean(false)
    private val busy = AtomicBoolean(false)
    private val ring = ShortArray(16_000 * 5)
    private var cursor = 0
    private var count = 0
    private var sincePrediction = 0
    private var epoch = -1L
    private var decoder: LocalBoundarySpeechDecoder? = null

    @Synchronized fun accept(samples: ShortArray, generation: Long) {
        if (closed.get()) return
        if (epoch != generation) {
            epoch = generation
            cursor = 0; count = 0; sincePrediction = 0
            ring.fill(0)
        }
        for (sample in samples) {
            ring[cursor] = sample
            cursor = (cursor + 1) % ring.size
            count = minOf(count + 1, ring.size)
        }
        sincePrediction += samples.size
        if (count < 12_800 || sincePrediction < 9_600 || !busy.compareAndSet(false, true)) return
        sincePrediction = 0
        val window = ShortArray(count) { ring[(cursor - count + it + ring.size) % ring.size] }
        executor.execute {
            try {
                if (!closed.get()) {
                    val loaded = decoder ?: createDecoder().also { decoder = it }
                    val text = loaded.decode(window)
                    synchronized(this) {
                        if (!closed.get() && epoch == generation) onTranscript(generation, text)
                    }
                }
            } catch (error: Exception) {
                if (!closed.get()) onError(error)
            } finally {
                window.fill(0)
                busy.set(false)
            }
        }
    }

    /** Invalidate pending predictions without stopping the microphone or releasing the shared decoder. */
    @Synchronized fun reset() {
        epoch = -1L; cursor = 0; count = 0; sincePrediction = 0
        ring.fill(0)
    }

    @Synchronized override fun close() {
        if (!closed.compareAndSet(false, true)) return
        reset()
        executor.execute { decoder?.close(); decoder = null }
        executor.shutdown()
    }
}
