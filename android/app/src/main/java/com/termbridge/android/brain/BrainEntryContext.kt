package com.termbridge.android.brain

/** One-shot hidden context carried from a Terminal entry until its first request is durable. */
internal class BrainEntryContext {
    var sourceSessionId: String? = null
        private set

    fun accept(sourceSessionId: String?, clear: Boolean) {
        val source = sourceSessionId?.trim().orEmpty()
        when {
            source.isNotEmpty() -> this.sourceSessionId = source.take(MAX_SESSION_ID_CHARS)
            clear -> this.sourceSessionId = null
        }
    }

    fun appendTo(fields: MutableList<Pair<String, Any?>>) {
        sourceSessionId?.let { fields += "sourceSessionId" to it }
    }

    fun consume() {
        sourceSessionId = null
    }

    private companion object {
        const val MAX_SESSION_ID_CHARS = 256
    }
}
