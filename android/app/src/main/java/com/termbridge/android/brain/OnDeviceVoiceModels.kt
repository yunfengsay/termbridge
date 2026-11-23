package com.termbridge.android.brain

import android.content.Context
import com.k2fsa.sherpa.onnx.OnlineSpeechDenoiser
import com.k2fsa.sherpa.onnx.OnlineSpeechDenoiserConfig
import com.k2fsa.sherpa.onnx.OfflineSpeechDenoiserGtcrnModelConfig
import com.k2fsa.sherpa.onnx.OfflineSpeechDenoiserModelConfig
import com.k2fsa.sherpa.onnx.SileroVadModelConfig
import com.k2fsa.sherpa.onnx.SpeakerEmbeddingExtractor
import com.k2fsa.sherpa.onnx.SpeakerEmbeddingExtractorConfig
import com.k2fsa.sherpa.onnx.Vad
import com.k2fsa.sherpa.onnx.VadModelConfig

internal data class DenoisedVoiceBlock(
    val frames: List<ShortArray>,
    val probabilities: FloatArray,
)

class OnDeviceVoiceModels(context: Context) : AutoCloseable {
    private val vad = Vad(
        assetManager = context.assets,
        config = VadModelConfig(
            sileroVadModelConfig = SileroVadModelConfig(
                model = VAD_MODEL,
                threshold = 0.5f,
                minSilenceDuration = 0.25f,
                minSpeechDuration = 0.1f,
                windowSize = WINDOW_SAMPLES,
                maxSpeechDuration = 20f,
            ),
            sampleRate = SAMPLE_RATE,
            numThreads = 1,
            provider = "cpu",
        ),
    )
    private val extractor = SpeakerEmbeddingExtractor(
        assetManager = context.assets,
        config = SpeakerEmbeddingExtractorConfig(
            model = SPEAKER_MODEL,
            numThreads = 2,
            provider = "cpu",
        ),
    )

    // A single stateful STFT/GTCRN stream for the capture. Offline.run resets
    // recurrent state on every call and damages speech at chunk boundaries.
    private val denoisedFrames = StreamingDenoisedFrames(WINDOW_SAMPLES)
    private val denoiser = OnlineSpeechDenoiser(
        assetManager = context.assets,
        config = OnlineSpeechDenoiserConfig(
            model = OfflineSpeechDenoiserModelConfig(
                gtcrn = OfflineSpeechDenoiserGtcrnModelConfig(model = DENOISE_MODEL),
                numThreads = 1,
                debug = false,
                provider = "cpu",
            ),
        ),
    )
    private val cleanVad = Vad(
        assetManager = context.assets,
        config = VadModelConfig(
            sileroVadModelConfig = SileroVadModelConfig(
                model = VAD_MODEL,
                threshold = 0.5f,
                minSilenceDuration = 0.25f,
                minSpeechDuration = 0.1f,
                windowSize = WINDOW_SAMPLES,
                maxSpeechDuration = 20f,
            ),
            sampleRate = SAMPLE_RATE,
            numThreads = 1,
            provider = "cpu",
        ),
    )

    /** Denoises once, then uses the exact same cleaned frames for local VAD and cloud ASR. */
    internal fun denoise(block: List<ShortArray>): DenoisedVoiceBlock {
        val merged = FloatArray(block.sumOf { it.size })
        var offset = 0
        block.forEach { frame ->
            frame.forEach { sample -> merged[offset++] = sample / 32768f }
        }
        val cleaned = denoiser.run(merged, SAMPLE_RATE).samples
        return classifyCleanFrames(denoisedFrames.append(cleaned))
    }

    internal fun finishDenoise(): DenoisedVoiceBlock {
        val frames = denoisedFrames.append(denoiser.flush().samples) + denoisedFrames.finish()
        return classifyCleanFrames(frames)
    }

    private fun classifyCleanFrames(frames: List<ShortArray>) = DenoisedVoiceBlock(
        frames,
        FloatArray(frames.size) { index ->
            cleanVad.compute(FloatArray(WINDOW_SAMPLES) { sample -> frames[index][sample] / 32768f })
        },
    )

    fun resetVad() = vad.reset()

    fun resetCleanVad() {
        cleanVad.reset()
        denoiser.reset()
        denoisedFrames.reset()
    }

    fun speechProbability(samples: ShortArray): Float {
        require(samples.size == WINDOW_SAMPLES)
        return vad.compute(FloatArray(samples.size) { index -> samples[index] / 32768f })
    }

    fun embedding(frames: List<ShortArray>): FloatArray? {
        if (frames.isEmpty()) return null
        val stream = extractor.createStream()
        return try {
            frames.forEach { frame ->
                stream.acceptWaveform(
                    samples = FloatArray(frame.size) { index -> frame[index] / 32768f },
                    sampleRate = SAMPLE_RATE,
                )
            }
            stream.inputFinished()
            if (extractor.isReady(stream)) extractor.compute(stream) else null
        } finally {
            stream.release()
        }
    }

    override fun close() {
        vad.release()
        cleanVad.release()
        denoiser.release()
        extractor.release()
    }

    companion object {
        const val SAMPLE_RATE = 16_000
        const val WINDOW_SAMPLES = 512
        private const val VAD_MODEL = "silero_vad.onnx"
        private const val SPEAKER_MODEL = "3dspeaker_campplus_zh.onnx"
        private const val DENOISE_MODEL = "gtcrn_simple.onnx"
    }
}
