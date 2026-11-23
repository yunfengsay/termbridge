package com.termbridge.android.brain

import com.k2fsa.sherpa.onnx.FeatureConfig
import com.k2fsa.sherpa.onnx.OfflineModelConfig
import com.k2fsa.sherpa.onnx.OfflineRecognizer
import com.k2fsa.sherpa.onnx.OfflineRecognizerConfig
import com.k2fsa.sherpa.onnx.OfflineSenseVoiceModelConfig
import java.io.File

/** Local transcript for boundary decisions only; never replaces the cloud conversation model. */
class LocalBoundarySpeechDecoder(directory: File) : AutoCloseable {
    private val recognizer = OfflineRecognizer(config = OfflineRecognizerConfig(
        featConfig = FeatureConfig(sampleRate = 16_000, featureDim = 80),
        modelConfig = OfflineModelConfig(
            senseVoice = OfflineSenseVoiceModelConfig(
                model = File(directory, "model.int8.onnx").absolutePath,
                language = "auto", useInverseTextNormalization = true,
            ),
            tokens = File(directory, "tokens.txt").absolutePath,
            numThreads = 1, provider = "cpu",
        ),
    ))

    fun decode(samples: ShortArray): String {
        require(samples.size <= 16_000 * 15) { "Local boundary audio must be bounded" }
        val stream = recognizer.createStream()
        return try {
            stream.acceptWaveform(FloatArray(samples.size) { samples[it] / 32768f }, 16_000)
            recognizer.decode(stream)
            recognizer.getResult(stream).text.trim()
        } finally { stream.release() }
    }

    override fun close() = recognizer.release()
}
