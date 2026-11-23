package com.termbridge.android.brain

import java.util.Locale

object BrainSpeechText {
    private val fencedCode = Regex("```[\\s\\S]*?```")
    private val markdownImage = Regex("!\\[([^]]*)]\\([^)]*\\)")
    private val markdownLink = Regex("\\[([^]]+)]\\([^)]*\\)")
    private val bareUrl = Regex("https?://\\S+")
    private val markdownPunctuation = Regex("(^|\\s)[#>*_~-]+(?=\\s)")
    private val whitespace = Regex("\\s+")
    private val han = Regex("[\\p{IsHan}]")

    fun normalize(text: String, maxCharacters: Int = 800): String = text
        .replace(fencedCode, " code block ")
        .replace(markdownImage, "$1")
        .replace(markdownLink, "$1")
        .replace(bareUrl, "")
        .replace('`', ' ')
        .replace(markdownPunctuation, "$1")
        .replace(whitespace, " ")
        .trim()
        .take(maxCharacters)

    fun localeFor(text: String): Locale = if (han.containsMatchIn(text)) {
        Locale.SIMPLIFIED_CHINESE
    } else {
        Locale.US
    }
}
