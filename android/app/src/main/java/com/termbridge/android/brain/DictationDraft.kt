package com.termbridge.android.brain

/** ASR sentence boundaries never submit a task. Only a final explicit keyword can. */
class DictationDraft(initial: String, private val keyword: String) {
    private var committed = initial.trim()
    private var partial = ""
    val text: String get() = VoiceSendCommand.append(committed, partial)

    fun accept(transcript: String, final: Boolean): Boolean {
        if (!final) { partial = transcript; return false }
        val command = VoiceSendCommand.parse(transcript, keyword)
        committed = VoiceSendCommand.append(committed, command.text)
        partial = ""
        return command.shouldSend && committed.isNotBlank()
    }
}
