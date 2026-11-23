package com.termbridge.android.brain

import android.content.Context
import org.json.JSONObject
import java.io.File
import java.util.UUID

/** Explicit opt-in only. No PCM, device IDs, Host addresses, or automatic network export. */
class VoiceBoundaryLearningStore(context: Context) {
    private val directory = File(context.noBackupFilesDir, "voice-boundary-samples-v1")
    private val settings = VoiceSettingsStore(context)

    enum class Label(val value: String) {
        MANUAL_END("manual_end"),
        POSSIBLE_PREMATURE_END("possible_premature_end"),
        NOT_ADDRESSED("not_addressed"),
    }

    data class Example(
        val eventId: String,
        val label: Label,
        val previousUser: String,
        val previousAssistant: String,
        val currentUser: String,
        val detectorVersion: String,
        val score: Float? = null,
    )

    fun record(example: Example, now: Long = System.currentTimeMillis()): Boolean = synchronized(lock) {
        if (!settings.load().boundaryLearningEnabled) return false
        require(runCatching { UUID.fromString(example.eventId) }.isSuccess)
        directory.mkdirs()
        val target = File(directory, "${example.eventId}.json")
        if (target.exists()) return false
        prune(now)
        val record = JSONObject()
            .put("schemaVersion", 1)
            .put("id", example.eventId)
            .put("atEpochMs", now)
            .put("label", example.label.value)
            .put("labelSource", "user_correction")
            .put("reviewed", false)
            .put("previousUser", redact(example.previousUser))
            .put("previousAssistant", redact(example.previousAssistant))
            .put("currentUser", redact(example.currentUser))
            .put("detectorVersion", example.detectorVersion.take(80))
        example.score?.takeIf(Float::isFinite)?.let { record.put("score", it.toDouble()) }
        target.writeText(record.toString())
        true
    }

    fun entries(now: Long = System.currentTimeMillis()): List<String> = synchronized(lock) {
        prune(now)
        files().sortedByDescending(File::lastModified).mapNotNull { file ->
            runCatching { JSONObject(file.readText()).toString() }.getOrNull()
        }
    }

    fun delete(id: String): Boolean = synchronized(lock) {
        require(runCatching { UUID.fromString(id) }.isSuccess)
        File(directory, "$id.json").delete()
    }

    /** Disabling happens before deletion, so callbacks already queued on capture cannot recreate data. */
    fun disableAndClear() = synchronized(lock) {
        settings.setBoundaryLearningEnabled(false)
        files().forEach { check(it.delete()) { "Could not delete local sample" } }
    }

    private fun files(): List<File> = directory.listFiles()?.filter {
        it.isFile && Regex("[0-9a-fA-F-]{36}\\.json").matches(it.name)
    }.orEmpty()

    private fun prune(now: Long) {
        files().filter { now - it.lastModified() > RETENTION_MS }.forEach(File::delete)
        files().sortedByDescending(File::lastModified).drop(MAX_EXAMPLES - 1).forEach(File::delete)
    }

    companion object {
        private val lock = Any()
        const val MAX_EXAMPLES = 10_000
        const val RETENTION_MS = 30L * 24 * 60 * 60 * 1000
        private fun redact(text: String): String = text.take(1000)
            .replace(Regex("(?i)(sk-[a-z0-9_-]+|tb1_[a-z0-9_-]+|https?://[^\\s]+)"), "[redacted]")
            .replace(Regex("(?i)(password|token|secret|api.?key|密码|密钥)\\s*[:：=]\\s*[^\\s,，;；]+"), "$1=[redacted]")
    }
}
