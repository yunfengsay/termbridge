package com.termbridge.android.brain

import android.content.Context
import android.util.Log
import org.json.JSONObject
import java.io.File

object VoiceDiagnostics {
    private const val TAG = "TermBridgeVoice"
    private const val MAX_LOG_BYTES = 2L * 1024L * 1024L
    private val lock = Any()

    fun record(
        context: Context,
        event: String,
        requestId: String? = null,
        provider: String? = null,
        fields: Map<String, Any?> = emptyMap(),
    ) {
        val record = JSONObject()
            .put("atEpochMs", System.currentTimeMillis())
            .put("event", safe(event, 80))
        requestId?.takeIf(String::isNotBlank)?.let { record.put("requestId", safe(it, 128)) }
        provider?.takeIf(String::isNotBlank)?.let { record.put("provider", safe(it, 32)) }
        fields.forEach { (rawKey, value) ->
            val key = rawKey.replace(Regex("[^a-zA-Z0-9_.-]"), "").take(64)
            if (key.isEmpty() || key.contains(Regex("token|secret|key|audio|text|prompt", RegexOption.IGNORE_CASE))) {
                return@forEach
            }
            when (value) {
                is String -> record.put(key, safe(value, 256))
                is Number, is Boolean -> record.put(key, value)
                null -> record.put(key, JSONObject.NULL)
            }
        }
        val line = record.toString()
        Log.i(TAG, line)
        runCatching {
            synchronized(lock) {
                val directory = File(context.filesDir, "diagnostics").apply { mkdirs() }
                val file = File(directory, "voice-events.jsonl")
                if (file.length() >= MAX_LOG_BYTES) file.writeText("")
                file.appendText("$line\n")
            }
        }.onFailure { Log.w(TAG, "could not append voice diagnostic event", it) }
    }

    private fun safe(value: String, max: Int): String = value
        .replace(Regex("[\\r\\n\\u0000-\\u001f]+"), " ")
        .trim()
        .take(max)
}
