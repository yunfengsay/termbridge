package com.termbridge.android.brain

data class VoiceCommandResult(val text: String, val shouldSend: Boolean)

object VoiceSendCommand {
    private val trailingPunctuation = Regex("[\\s，。！？、,.!?；;：:]+$")

    /** The configured keyword is a deliberate end-of-utterance command, never a fuzzy intent. */
    fun parse(
        transcript: String,
        keyword: String = VoiceSettingsStore.DEFAULT_SEND_KEYWORD,
    ): VoiceCommandResult {
        val spoken = transcript.trim()
        val withoutPunctuation = spoken.replace(trailingPunctuation, "")
        val command = VoiceSettingsStore.normalizeKeyword(keyword)
        if (!withoutPunctuation.endsWith(command)) return VoiceCommandResult(spoken, false)
        return VoiceCommandResult(
            text = withoutPunctuation.dropLast(command.length).replace(trailingPunctuation, "").trim(),
            shouldSend = true,
        )
    }

    fun append(existing: String, next: String): String {
        val left = existing.trim()
        val right = next.trim()
        return when {
            left.isEmpty() -> right
            right.isEmpty() -> left
            else -> "$left $right"
        }
    }

}
