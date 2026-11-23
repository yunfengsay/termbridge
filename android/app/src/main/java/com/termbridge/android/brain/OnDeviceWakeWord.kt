package com.termbridge.android.brain

import android.content.Context
import android.icu.text.Transliterator
import com.k2fsa.sherpa.onnx.FeatureConfig
import com.k2fsa.sherpa.onnx.KeywordSpotter
import com.k2fsa.sherpa.onnx.KeywordSpotterConfig
import com.k2fsa.sherpa.onnx.OnlineModelConfig
import com.k2fsa.sherpa.onnx.OnlineTransducerModelConfig
import java.text.Normalizer

/** CPU-only keyword spotting, owned and released by the capture thread. No network or ASR. */
class OnDeviceWakeWord(context: Context, keyword: String) : AutoCloseable {
    private val spotter: KeywordSpotter
    private val stream: com.k2fsa.sherpa.onnx.OnlineStream

    init {
        val tokens = context.assets.open("$DIR/tokens.txt").bufferedReader().useLines { lines ->
            lines.map { it.substringBefore(' ') }.toSet()
        }
        val encoded = encode(keyword, tokens)
        spotter = KeywordSpotter(context.assets, KeywordSpotterConfig(
            featConfig = FeatureConfig(sampleRate = 16_000, featureDim = 80),
            modelConfig = OnlineModelConfig(
                transducer = OnlineTransducerModelConfig(
                    encoder = "$DIR/encoder.onnx",
                    decoder = "$DIR/decoder.onnx",
                    joiner = "$DIR/joiner.onnx",
                ),
                tokens = "$DIR/tokens.txt", numThreads = 1, provider = "cpu", modelType = "zipformer2",
            ),
            // createStream adds to the default graph: keep it empty so old/default words cannot wake.
            keywordsFile = "$DIR/empty-keywords.txt",
            keywordsThreshold = 0.35f, keywordsScore = 1.5f, numTrailingBlanks = 2,
        ))
        stream = try { spotter.createStream(encoded) } catch (error: Exception) { spotter.release(); throw error }
    }

    fun accept(samples: ShortArray): Boolean {
        stream.acceptWaveform(FloatArray(samples.size) { samples[it] / 32768f }, 16_000)
        while (spotter.isReady(stream)) {
            spotter.decode(stream)
            if (spotter.getResult(stream).keyword.isNotEmpty()) {
                spotter.reset(stream)
                return true
            }
        }
        return false
    }

    fun reset() = spotter.reset(stream)
    override fun close() { stream.release(); spotter.release() }

    companion object {
        const val DIR = "wake-word-zh-3m"
        fun validateKeyword(value: String): String = value.trim().also {
            require(Regex("[\\u4e00-\\u9fff]{3,8}").matches(it)) { "唤醒词请使用 3–8 个中文汉字 / Use 3–8 Chinese characters" }
        }

        /** Android ICU supplies tone-marked pinyin locally; reject unsupported syllables instead of guessing. */
        fun encode(keyword: String, vocabulary: Set<String>): String {
            val word = validateKeyword(keyword)
            if (android.os.Build.VERSION.SDK_INT < 29) {
                require(word == "你好小桥") { "自定义唤醒词需要 Android 10 或以上 / Custom wake words require Android 10+" }
                return "n ǐ h ǎo x iǎo q iáo @你好小桥"
            }
            val transliterator = Transliterator.getInstance("Han-Latin")
            val initials = listOf("zh", "ch", "sh", "b", "p", "m", "f", "d", "t", "n", "l", "g", "k", "h", "j", "q", "x", "r", "z", "c", "s", "y", "w")
            val parts = word.flatMap { character ->
                val pinyin = Normalizer.normalize(transliterator.transliterate(character.toString()).trim(), Normalizer.Form.NFC)
                val initial = initials.firstOrNull { pinyin.startsWith(it) }
                val syllable = if (initial != null && pinyin.length > initial.length) {
                    listOf(initial, pinyin.substring(initial.length))
                } else listOf(pinyin)
                require(syllable.all { it in vocabulary }) { "唤醒词包含模型不支持的发音 / Unsupported wake-word pronunciation" }
                syllable
            }
            return parts.joinToString(" ") + " @$word"
        }
    }
}
