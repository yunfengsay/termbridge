package com.termbridge.android.brain

import java.text.Normalizer
import java.util.Locale

/** Matches a reserved command at an utterance boundary, never substrings such as 'overflow'. */
object VoiceStopWords {
    val DEFAULT = listOf("Over", "说完了")
    private val trailingPunctuation = Regex("[\\s，。！？,.!?；;：:]+$")

    fun parse(value: String): List<String> {
        val words = value.split(Regex("[,，;；\\n\\r]+"))
            .map(String::trim).filter(String::isNotEmpty).distinctBy(::normalize)
        require(words.size in 1..5) { "请设置 1–5 个停止词 / Set 1–5 stop phrases" }
        require(words.all { Regex("[\\p{IsHan}A-Za-z ]{2,24}").matches(it) }) {
            "停止词请使用 2–24 个中英文字母 / Use 2–24 Chinese or English characters"
        }
        return words
    }

    data class Match(val keyword: String, val precedingText: String)

    fun match(text: String, words: List<String>): Match? {
        val normalized = normalize(text).replace(trailingPunctuation, "")
        return words.sortedByDescending(String::length).firstNotNullOfOrNull { word ->
            val suffix = normalize(word)
            if (!normalized.endsWith(suffix)) return@firstNotNullOfOrNull null
            val start = normalized.length - suffix.length
            // An English word must not match the tail of 'leftover', 'takeover', etc.
            if (suffix.firstOrNull() in 'a'..'z' && start > 0 && normalized[start - 1] in 'a'..'z') {
                return@firstNotNullOfOrNull null
            }
            Match(word, normalized.substring(0, start).replace(trailingPunctuation, ""))
        }
    }

    private fun normalize(text: String): String = Normalizer.normalize(text, Normalizer.Form.NFKC)
        .lowercase(Locale.ROOT).trim()
}
