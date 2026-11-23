package com.termbridge.android.brain

/** One capture's delayed model output, reframed without raw-audio substitution. */
internal class StreamingDenoisedFrames(private val frameSize: Int = 512) {
    private var pending = ShortArray(frameSize)
    private var filled = 0

    init { require(frameSize > 0) }

    fun append(samples: FloatArray): List<ShortArray> {
        val frames = ArrayList<ShortArray>()
        for (sample in samples) {
            require(sample.isFinite()) { "Non-finite denoiser output" }
            pending[filled++] = (sample.coerceIn(-1f, 1f) * 32768f).toInt()
                .coerceIn(Short.MIN_VALUE.toInt(), Short.MAX_VALUE.toInt()).toShort()
            if (filled == frameSize) {
                frames.add(pending)
                pending = ShortArray(frameSize)
                filled = 0
            }
        }
        return frames
    }

    /** Call only at capture completion, never between audio chunks. */
    fun finish(): List<ShortArray> = if (filled == 0) emptyList() else listOf(pending).also { reset() }

    fun reset() {
        pending = ShortArray(frameSize)
        filled = 0
    }
}
