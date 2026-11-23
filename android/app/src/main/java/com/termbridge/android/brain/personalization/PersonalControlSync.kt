package com.termbridge.android.brain.personalization

import android.content.Context
import com.termbridge.android.protocol.ControlMessage
import java.util.UUID
import java.util.concurrent.Executors

/** Reuses an already connected Brain channel. No microphone, independent socket, or background job. */
class PersonalControlSync(context: Context) {
    private val store = PersonalControlStore(context.applicationContext)
    private val executor = Executors.newSingleThreadExecutor()
    private var pending: String? = null
    private var lastAttempt = 0L
    @Volatile private var closed = false
    fun connected(host: String, capability: Int, send: (Map<String, Any?>) -> Boolean) {
        if (closed || capability < 2) return
        executor.execute {
            val now = android.os.SystemClock.elapsedRealtime()
            if (closed || now - lastAttempt < 15_000) return@execute
            runCatching {
                if (!store.needsSync(host)) return@runCatching
                lastAttempt = now
                val id = UUID.randomUUID().toString(); pending = id
                if (!send(store.request(id))) pending = null
            }
        }
    }
    fun accept(host: String, message: ControlMessage): Boolean {
        if (closed || message.type != "voice_learning_result") return false
        executor.execute {
            if (message.string("requestId") != pending) return@execute
            pending = null
            runCatching {
                val revision = ControlModel.wireRevision(message.fields["revision"])
                val accepted = when (message.string("status")) {
                    "completed" -> store.applyHost(revision, message.fields["model"] as Map<*, *>)
                    "revoked" -> true
                    else -> false
                }
                if (accepted) store.acknowledge(host, revision, message.fields["assist"] as? Map<*, *>)
            }
        }
        return true
    }
    fun close() { closed = true; executor.shutdown() }
}
