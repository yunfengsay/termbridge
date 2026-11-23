package com.termbridge.android.watch

import android.content.Context
import androidx.core.content.edit
import java.util.Locale
import org.json.JSONArray
import org.json.JSONObject

data class ZeppWatchPreferences(
    val notifyAttention: Boolean = true,
    val notifyFailure: Boolean = true,
    val notifyCompletion: Boolean = true,
    val confirmVoiceBeforeSend: Boolean = true,
) {
    fun allows(status: String): Boolean = when (status.lowercase(Locale.US)) {
        "waiting", "approval", "blocked" -> notifyAttention
        "failed", "error" -> notifyFailure
        "done" -> notifyCompletion
        else -> false
    }
}

object ZeppWatchPreferencesStore {
    fun load(context: Context): ZeppWatchPreferences {
        val preferences = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
        return ZeppWatchPreferences(
            notifyAttention = preferences.getBoolean(KEY_ATTENTION, true),
            notifyFailure = preferences.getBoolean(KEY_FAILURE, true),
            notifyCompletion = preferences.getBoolean(KEY_COMPLETION, true),
            confirmVoiceBeforeSend = preferences.getBoolean(KEY_CONFIRM_VOICE, true),
        )
    }

    fun save(context: Context, value: ZeppWatchPreferences) {
        context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE).edit {
            putBoolean(KEY_ATTENTION, value.notifyAttention)
            putBoolean(KEY_FAILURE, value.notifyFailure)
            putBoolean(KEY_COMPLETION, value.notifyCompletion)
            putBoolean(KEY_CONFIRM_VOICE, value.confirmVoiceBeforeSend)
        }
    }

    private const val PREFERENCES = "termbridge_zepp_preferences"
    private const val KEY_ATTENTION = "notify_attention"
    private const val KEY_FAILURE = "notify_failure"
    private const val KEY_COMPLETION = "notify_completion"
    private const val KEY_CONFIRM_VOICE = "confirm_voice_before_send"
}

object ZeppWatchSnoozeStore {
    fun snooze(context: Context, sessionId: String, until: Long) {
        context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE).edit {
            putLong(sessionId.take(256), until.coerceAtLeast(0L))
        }
    }

    fun isSnoozed(context: Context, sessionId: String, now: Long = System.currentTimeMillis()): Boolean {
        val preferences = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
        val key = sessionId.take(256)
        val until = preferences.getLong(key, 0L)
        if (until <= now) {
            if (until > 0L) preferences.edit { remove(key) }
            return false
        }
        return true
    }

    private const val PREFERENCES = "termbridge_zepp_snoozes"
}

data class ZeppWatchActivity(
    val kind: String,
    val state: String,
    val title: String,
    val summary: String,
    val sessionId: String,
    val occurredAt: Long,
)

object ZeppWatchActivityStore {
    fun load(context: Context): List<ZeppWatchActivity> = runCatching {
        val raw = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE).getString(KEY_HISTORY, null)
        val array = JSONArray(raw ?: "[]")
        buildList {
            for (index in 0 until minOf(array.length(), MAX_ENTRIES)) {
                val item = array.optJSONObject(index) ?: continue
                add(
                    ZeppWatchActivity(
                        kind = item.optString("kind").take(32),
                        state = item.optString("state").take(32),
                        title = item.optString("title").take(96),
                        summary = item.optString("summary").take(320),
                        sessionId = item.optString("sessionId").take(256),
                        occurredAt = item.optLong("occurredAt").coerceAtLeast(0L),
                    ),
                )
            }
        }
    }.getOrDefault(emptyList())

    @Synchronized
    fun append(context: Context, entry: ZeppWatchActivity) {
        val items = buildList {
            add(entry)
            addAll(load(context))
        }.take(MAX_ENTRIES)
        val encoded = JSONArray().apply {
            items.forEach { item ->
                put(JSONObject().apply {
                    put("kind", item.kind)
                    put("state", item.state)
                    put("title", item.title)
                    put("summary", item.summary)
                    put("sessionId", item.sessionId)
                    put("occurredAt", item.occurredAt)
                })
            }
        }.toString()
        context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE).edit { putString(KEY_HISTORY, encoded) }
    }

    private const val PREFERENCES = "termbridge_zepp_activity"
    private const val KEY_HISTORY = "history"
    private const val MAX_ENTRIES = 20
}
