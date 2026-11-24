package com.termbridge.android.cache

import org.json.JSONObject

/**
 * Bounded in-memory LRU cache of recent session snapshots so opening a recently visited
 * terminal or Agent Chat paints immediately at 0ms while live sync reconciles in the background.
 */
object SessionSnapshotCache {
    data class TerminalSnapshot(val revision: Int, val payload: ByteArray, val savedAtMs: Long)
    data class ChatSnapshot(val payloadJson: String, val savedAtMs: Long)

    private const val MAX_ENTRIES = 12
    private const val MAX_ENTRY_BYTES = 256 * 1024
    private const val TTL_MS = 30 * 60_000L

    private val terminalCache = object : LinkedHashMap<String, TerminalSnapshot>(16, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, TerminalSnapshot>?): Boolean =
            size > MAX_ENTRIES
    }

    private val chatCache = object : LinkedHashMap<String, ChatSnapshot>(16, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, ChatSnapshot>?): Boolean =
            size > MAX_ENTRIES
    }

    private fun key(profileKey: String, sessionId: String): String = "$profileKey\u0000$sessionId"

    @Synchronized
    fun putTerminal(profileKey: String, sessionId: String, revision: Int, payload: ByteArray) {
        if (payload.isEmpty() || payload.size > MAX_ENTRY_BYTES) return
        terminalCache[key(profileKey, sessionId)] = TerminalSnapshot(revision, payload.copyOf(), System.currentTimeMillis())
    }

    @Synchronized
    fun getTerminal(profileKey: String, sessionId: String): TerminalSnapshot? {
        val k = key(profileKey, sessionId)
        val entry = terminalCache[k] ?: return null
        if (System.currentTimeMillis() - entry.savedAtMs > TTL_MS) {
            terminalCache.remove(k)
            return null
        }
        return entry
    }

    @Synchronized
    fun putChatRaw(profileKey: String, conversationId: String, rawJson: String) {
        if (rawJson.isEmpty() || rawJson.length > MAX_ENTRY_BYTES) return
        chatCache[key(profileKey, conversationId)] = ChatSnapshot(rawJson, System.currentTimeMillis())
    }

    @Synchronized
    fun getChatRaw(profileKey: String, conversationId: String): String? {
        val k = key(profileKey, conversationId)
        val entry = chatCache[k] ?: return null
        if (System.currentTimeMillis() - entry.savedAtMs > TTL_MS) {
            chatCache.remove(k)
            return null
        }
        return entry.payloadJson
    }

    fun putChat(profileKey: String, conversationId: String, payload: JSONObject) {
        putChatRaw(profileKey, conversationId, payload.toString())
    }

    fun getChat(profileKey: String, conversationId: String): JSONObject? =
        getChatRaw(profileKey, conversationId)?.let { runCatching { JSONObject(it) }.getOrNull() }

    @Synchronized
    fun clear() {
        terminalCache.clear()
        chatCache.clear()
    }
}
