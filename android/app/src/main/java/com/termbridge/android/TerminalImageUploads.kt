package com.termbridge.android

import java.util.UUID

/** Main-thread queue: picker results may arrive before the new connection's attach_ok. */
class TerminalImageUploads {
    data class Upload(
        val id: String,
        val sessionId: String,
        var image: EncodedImage? = null,
        var sent: Boolean = false,
        /** Sent, then the connection went away: the outcome can never be known. */
        var unknown: Boolean = false,
    )
    private val entries = linkedMapOf<String, Upload>()
    /** Uploads still expected to resolve. An unknown one never will. */
    val size: Int get() = entries.values.count { !it.unknown }

    /** Sent before the connection dropped; kept, never resent, never claimed. */
    val unknownCount: Int get() = entries.values.count { it.unknown }
    /**
     * Whether anything is still expected to resolve.
     *
     * An upload whose outcome can never be learned is not "in progress": it is a
     * decision waiting for the user. Counting it here is what wedged the
     * composer — the send button and the IME path both refuse while uploads are
     * outstanding, and the control that clears them refused for the same reason,
     * so the only way out was to leave the conversation.
     */
    fun isEmpty(): Boolean = size == 0
    fun isNotEmpty(): Boolean = size > 0

    /** Whether any kept-but-unresolved upload is waiting to be dealt with. */
    fun hasUnknown(): Boolean = unknownCount > 0

    /**
     * Everything this queue is still holding, unresolved uploads included.
     *
     * The bound is about memory, not about progress: a held upload still owns
     * its encoded bytes. Counting only the active ones would let a repeatedly
     * dropped connection accumulate images without limit, six at a time.
     */
    val retainedCount: Int get() = entries.size
    fun add(sessionId: String): String {
        val id = UUID.randomUUID().toString()
        entries[id] = Upload(id, sessionId)
        return id
    }
    fun encoded(id: String, image: EncodedImage) { entries[id]?.image = image }
    fun takeReady(attachedSessionId: String): List<Upload> = entries.values.filter {
        it.sessionId == attachedSessionId && it.image != null && !it.sent && !it.unknown
    }.onEach { it.sent = true }
    fun acknowledge(id: String, sessionId: String): Boolean {
        val entry = entries[id] ?: return false
        if (!entry.sent || entry.unknown || entry.sessionId != sessionId) return false
        entries.remove(id)
        return true
    }
    fun remove(id: String): Boolean = entries.remove(id) != null
    /**
     * The connection went away with these already sent.
     *
     * They are marked, not removed: the file may well be on the Host, and
     * deleting the entry would silently lose the user's picture. Nothing is
     * resent — an unknown write must not be repeated — and a late
     * acknowledgement for one is no longer accepted.
     */
    fun interrupted(): List<String> = entries.values.filter { it.sent && !it.unknown }
        .onEach { it.unknown = true }.map { it.id }

    /** Drops the entries whose outcome was never learned, at the user's ask. */
    fun clearUnknown() { entries.values.filter { it.unknown }.forEach { entries.remove(it.id) } }
    fun clear() { entries.clear() }
}
