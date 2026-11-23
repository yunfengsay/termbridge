package com.termbridge.android.peer

import android.content.Context
import org.json.JSONObject

class PhoneActionStore(context: Context) {
    private val preferences = context.applicationContext.getSharedPreferences(STORE, Context.MODE_PRIVATE)

    @Synchronized
    fun save(request: PhoneActionRequest): Boolean {
        if (load(request.actionId) != null || result(request.actionId) != null) return false
        preferences.edit().putString(requestKey(request.actionId), request.toJson().toString()).apply()
        return true
    }

    @Synchronized
    fun load(actionId: String): PhoneActionRequest? =
        preferences.getString(requestKey(actionId), null)?.let { raw ->
            runCatching { PhoneActionRequest.fromJson(JSONObject(raw)) }.getOrNull()
        }

    @Synchronized
    fun result(actionId: String): PhoneActionResult? =
        preferences.getString(resultKey(actionId), null)?.let { raw ->
            runCatching { PhoneActionResult.fromJson(JSONObject(raw)) }.getOrNull()
        }

    @Synchronized
    fun complete(result: PhoneActionResult) {
        preferences.edit().apply {
            if (result.state != "running" && result.state != "awaiting_user") remove(requestKey(result.actionId))
            putString(resultKey(result.actionId), result.toJson().toString())
        }.apply()
    }

    @Synchronized
    fun discard(actionId: String) {
        preferences.edit().remove(requestKey(actionId)).remove(resultKey(actionId)).apply()
    }

    private fun requestKey(actionId: String) = "request:$actionId"
    private fun resultKey(actionId: String) = "result:$actionId"

    private companion object {
        const val STORE = "phone_actions"
    }
}

object PhoneActionOutbox {
    private const val STORE = "phone_action_outbox"
    private const val IDS = "event_ids"
    private val sent = mutableSetOf<String>()
    private var appContext: Context? = null
    private var sender: ((Map<String, Any?>) -> Boolean)? = null

    @Synchronized
    fun attach(context: Context, send: (Map<String, Any?>) -> Boolean) {
        appContext = context.applicationContext
        sender = send
        sent.clear()
        flushLocked()
    }

    @Synchronized
    fun detach() {
        sender = null
        sent.clear()
    }

    @Synchronized
    fun enqueue(context: Context, event: PhoneActionEvent) {
        val preferences = context.applicationContext.getSharedPreferences(STORE, Context.MODE_PRIVATE)
        val ids = preferences.getStringSet(IDS, emptySet()).orEmpty().toMutableSet()
        ids += event.eventId
        preferences.edit()
            .putString(event.eventId, event.toJson().toString())
            .putStringSet(IDS, ids)
            .apply()
        appContext = context.applicationContext
        flushLocked()
    }

    @Synchronized
    fun acknowledge(context: Context, eventId: String) {
        val preferences = context.applicationContext.getSharedPreferences(STORE, Context.MODE_PRIVATE)
        val ids = preferences.getStringSet(IDS, emptySet()).orEmpty().toMutableSet()
        ids -= eventId
        preferences.edit().remove(eventId).putStringSet(IDS, ids).apply()
        sent -= eventId
    }

    private fun flushLocked() {
        val context = appContext ?: return
        val send = sender ?: return
        val preferences = context.getSharedPreferences(STORE, Context.MODE_PRIVATE)
        val ids = preferences.getStringSet(IDS, emptySet()).orEmpty().sorted()
        for (eventId in ids) {
            if (eventId in sent) continue
            val raw = preferences.getString(eventId, null) ?: continue
            val event = runCatching { PhoneActionEvent.fromJson(JSONObject(raw)) }.getOrNull() ?: continue
            if (send(event.toControlFields())) sent += eventId
        }
    }
}
