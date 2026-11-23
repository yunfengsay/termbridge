package com.termbridge.android.brain.personalization

import android.content.Context
import com.termbridge.android.brain.VoiceSettingsStore
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.UUID

/** One private snapshot. No backups/PCM. Text is independently opted in and only reviewed rows sync. */
class PersonalControlStore(context: Context) {
    private val file = File(context.noBackupFilesDir, "voice-control-v1.json")
    private val settings = VoiceSettingsStore(context)
    private fun load(): JSONObject = if (file.exists()) JSONObject(file.readText()) else JSONObject()
        .put("revision", 1L).put("enabled", settings.load().boundaryLearningEnabled).put("observations", JSONArray()).put("feedback", JSONArray())
    private fun save(state: JSONObject) {
        val pending = File(file.parentFile, "${file.name}.pending")
        pending.writeText(state.toString())
        check(pending.renameTo(file)) { "Cannot persist control feedback" }
    }
    private fun rows(state: JSONObject) = objects(state.getJSONArray("feedback")).map { row ->
        ControlFeedback(row.getString("id"), row.getString("group"), row.getLong("at"),
            numbers(row.getJSONArray("features")), row.getString("head"), row.getInt("label"))
    }
    private fun changed(state: JSONObject) {
        state.remove("assist")
        state.put("revision", maxOf(state.getLong("revision") + 1, System.currentTimeMillis()))
        state.put("model", modelJson(ControlModel.train(rows(state), "local-${state.getLong("revision")}")))
        save(state)
    }
    fun consent(enabled: Boolean) = synchronized(lock) {
        settings.setBoundaryLearningEnabled(enabled)
        val state = load().put("enabled", enabled)
        if (!enabled) state.put("observations", JSONArray()).put("feedback", JSONArray()).put("contextConsent", false).remove("assist")
        changed(state)
    }
    fun contextConsent(enabled: Boolean) = synchronized(lock) {
        val state = snapshot()
        if (enabled) { state.put("enabled", true); settings.setBoundaryLearningEnabled(true) }
        state.put("contextConsent", enabled).remove("assist")
        if (!enabled) for (key in listOf("observations", "feedback")) objects(state.getJSONArray(key)).forEach {
            it.remove("text"); it.remove("context")
        }
        changed(state)
    }
    fun snapshot(): JSONObject = synchronized(lock) {
        val state = load()
        val cutoff = System.currentTimeMillis() - 30L * 24 * 60 * 60 * 1000
        val observations = objects(state.getJSONArray("observations"))
        val kept = observations.filter { it.getLong("at") >= cutoff }
        if (kept.size != observations.size) {
            val ids = kept.map { it.getString("id") }.toSet()
            state.put("observations", JSONArray(kept)).put("feedback", JSONArray(objects(state.getJSONArray("feedback")).filter { it.getString("observation") in ids }))
            changed(state)
        }
        state
    }
    fun record(group: String, features: List<Double>, now: Long = System.currentTimeMillis(), text: String = "", context: String = ""): Boolean = synchronized(lock) {
        if (!settings.load().boundaryLearningEnabled) return false
        ControlModel().probability("addressed", features)
        val state = snapshot()
        if (!state.optBoolean("enabled")) return false
        val observation = JSONObject().put("id", UUID.randomUUID().toString()).put("group", group)
            .put("at", now).put("features", JSONArray(features))
        if (state.optBoolean("contextConsent") && text.isNotBlank()) observation.put("text", text.takeLast(320)).put("context", context.takeLast(320))
        val kept = (objects(state.getJSONArray("observations")) + observation).takeLast(250)
        val ids = kept.map { it.getString("id") }.toSet()
        val before = state.getJSONArray("feedback").length()
        state.put("observations", JSONArray(kept)).put("feedback", JSONArray(objects(state.getJSONArray("feedback")).filter { it.getString("observation") in ids }))
        // Unreviewed observations do not trigger training; expiry of reviewed rows does.
        if (before != state.getJSONArray("feedback").length()) changed(state) else save(state)
        true
    }
    /** Each decision is reviewed separately. Saying Over alone is never a DDSD label. */
    fun label(id: String, head: String, value: Int?) = synchronized(lock) {
        require(head in listOf("addressed", "finished") && (value == null || value in 0..1))
        val state = snapshot()
        check(state.optBoolean("enabled") && settings.load().boundaryLearningEnabled)
        val observation = objects(state.getJSONArray("observations")).first { it.getString("id") == id }
        val feedback = objects(state.getJSONArray("feedback")).filterNot { it.getString("observation") == id && it.getString("head") == head }.toMutableList()
        if (value != null) feedback.add(JSONObject(observation.toString()).put("observation", id)
            .put("id", UUID.nameUUIDFromBytes("$id:$head".toByteArray()).toString())
            .put("head", head).put("label", value).put("source", "human"))
        state.put("feedback", JSONArray(feedback))
        changed(state)
    }
    fun delete(id: String) = synchronized(lock) {
        val state = snapshot()
        state.put("observations", JSONArray(objects(state.getJSONArray("observations")).filterNot { it.getString("id") == id }))
        state.put("feedback", JSONArray(objects(state.getJSONArray("feedback")).filterNot { it.getString("observation") == id }))
        changed(state)
    }
    fun request(id: String): Map<String, Any?> = synchronized(lock) {
        val state = snapshot()
        mapOf("t" to "voice_learning_sync", "requestId" to id, "revision" to state.getLong("revision"),
            "enabled" to state.getBoolean("enabled"), "contextConsent" to state.optBoolean("contextConsent"),
            "samples" to objects(state.getJSONArray("feedback")).map { row ->
                mutableMapOf<String, Any?>("id" to row.getString("id"), "group" to row.getString("group"), "at" to row.getLong("at"),
                    "features" to numbers(row.getJSONArray("features")), "head" to row.getString("head"), "label" to row.getInt("label"), "source" to "human").also {
                    if (state.optBoolean("contextConsent") && row.has("text")) { it["text"] = row.getString("text"); it["context"] = row.optString("context") }
                }
            })
    }
    fun needsSync(host: String): Boolean = synchronized(lock) {
        val state = snapshot()
        state.getLong("revision") > 1 && state.optJSONObject("synced")?.optLong(host, 0) != state.getLong("revision")
    }
    fun acknowledge(host: String, revision: Long, assist: Map<*, *>? = null): Boolean = synchronized(lock) {
        val state = snapshot()
        if (revision != state.getLong("revision")) return false
        val synced = state.optJSONObject("synced") ?: JSONObject()
        state.put("synced", synced.put(host, revision))
        if (assist != null) state.put("assist", JSONObject(assist)).put("assistHost", host)
        save(state); true
    }
    fun applyHost(revision: Long, value: Map<*, *>): Boolean = synchronized(lock) {
        val state = snapshot()
        if (revision != state.getLong("revision") || !state.getBoolean("enabled") || !settings.load().boundaryLearningEnabled) return false
        val model = ControlModel.fromWire(value)
        state.put("model", modelJson(model)); save(state); true
    }
    fun model(): ControlModel = synchronized(lock) {
        if (!settings.load().boundaryLearningEnabled) return ControlModel()
        val value = snapshot().optJSONObject("model") ?: return ControlModel()
        ControlModel(value.getString("version"), value.getInt("samples"), numbers(value.getJSONArray("addressed")), numbers(value.getJSONArray("finished")))
    }
    companion object {
        private val lock = Any()
        fun objects(array: JSONArray): List<JSONObject> = (0 until array.length()).map(array::getJSONObject)
        fun numbers(array: JSONArray): List<Double> = (0 until array.length()).map(array::getDouble)
        fun modelJson(model: ControlModel) = JSONObject().put("schema", 1).put("mode", "shadow")
            .put("version", model.version).put("samples", model.samples).put("addressed", JSONArray(model.addressed)).put("finished", JSONArray(model.finished))
    }
}
