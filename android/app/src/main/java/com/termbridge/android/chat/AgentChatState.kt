package com.termbridge.android.chat

/** UI choices are local to this device, not a Host/Agent setting. */
enum class SessionUi(val wireValue: String) {
    AUTO("auto"), CHAT("chat"), TERMINAL("terminal");
    companion object { fun from(value: String?) = entries.firstOrNull { it.wireValue == value } ?: AUTO }
}

/**
 * Which view a session opens in. The default is a device setting, but a manual
 * switch inside one session is remembered for that session so a notification
 * clicked later reopens what the user actually chose. Resolved when the
 * notification is activated, never when it was created.
 */
object SessionUiRouting {
    const val MAX_OVERRIDES = 32

    fun startsInChat(default: SessionUi, override: SessionUi?, isHerdr: Boolean): Boolean =
        when (override ?: default) {
            SessionUi.CHAT -> true
            SessionUi.TERMINAL -> false
            SessionUi.AUTO -> isHerdr
        }

    /** Least-recently chosen entries are dropped first. */
    fun decode(raw: String?): LinkedHashMap<String, SessionUi> {
        val result = LinkedHashMap<String, SessionUi>()
        raw?.split('\n')?.forEach { line ->
            val separator = line.indexOf('\u0000')
            if (separator <= 0 || separator == line.length - 1) return@forEach
            val session = line.substring(0, separator)
            val mode = SessionUi.entries.firstOrNull { it.wireValue == line.substring(separator + 1) }
            if (mode != null && mode != SessionUi.AUTO) { result.remove(session); result[session] = mode }
        }
        return result
    }

    fun encode(values: Map<String, SessionUi>): String =
        values.entries.joinToString("\n") { it.key + "\u0000" + it.value.wireValue }

    /**
     * `AUTO` clears the session's own choice and lets the device default apply
     * again, so an override is never a one-way door.
     */
    fun with(raw: String?, sessionId: String, mode: SessionUi, limit: Int = MAX_OVERRIDES): String {
        if (sessionId.isBlank() || sessionId.contains('\u0000') || sessionId.contains('\n')) return raw.orEmpty()
        val values = decode(raw)
        values.remove(sessionId)
        if (mode != SessionUi.AUTO) values[sessionId] = mode
        while (values.size > limit) values.remove(values.keys.first())
        return encode(values)
    }

    fun of(raw: String?, sessionId: String): SessionUi? = decode(raw)[sessionId]
}

/** What the shell must do when the rendered page reports that it is ready. */
enum class SurfaceReadyAction {
    /** The page still owns its subscription; give it what arrived while it loaded. */
    REPLAY,

    /** Ask the Host for a fresh bounded snapshot. */
    SUBSCRIBE,

    /** Nothing to show yet; the connection will subscribe when it comes up. */
    WAIT,
}

/**
 * Tracks whether the rendered surface still holds what was sent to it. A page
 * that reloaded lost every event delivered to the previous one, and the cached
 * snapshot is older than what the Host has sent since, so the view asks for a
 * fresh bounded snapshot instead of replaying a stale one.
 */
class AgentChatSurfaceGate {
    var ready = false
        private set
    private var loadedOnce = false

    /**
     * Whether the page reached ready before is not enough on its own: a renderer
     * that dies before drawing its first frame also leaves the view with no
     * subscription, and replaying an empty cache there would sit blank forever.
     */
    fun becameReady(connected: Boolean, subscribed: Boolean): SurfaceReadyAction {
        val reloaded = loadedOnce
        ready = true
        loadedOnce = true
        if (!reloaded && subscribed) return SurfaceReadyAction.REPLAY
        return if (connected) SurfaceReadyAction.SUBSCRIBE else SurfaceReadyAction.WAIT
    }

    /** The page that acknowledged ready is gone. @return true when it had been live. */
    fun reset(): Boolean {
        val wasReady = ready
        ready = false
        return wasReady
    }
}

/** Kept outside Activity so a late receipt cannot mutate another conversation's composer. */
class AgentChatDraft {
    var text = ""
        set(value) { field = value; restored = false }
    var requestId: String? = null; private set
    var generation = -1; private set
    var state: String? = null; private set
    var error: String? = null; private set
    /** The record the Host observed this request as, once it has said which. */
    var messageId: String? = null; private set
    private var submitted = ""
    private var restored = false
    val pending get() = state == "accepted" || state == "delivered"
    val retryable get() = state == "failed"

    fun begin(id: String, viewGeneration: Int): String {
        check(!pending)
        submitted = text
        requestId = id; generation = viewGeneration; state = "accepted"; error = null; messageId = null
        text = ""
        return submitted
    }

    fun receipt(id: String, viewGeneration: Int, next: String, detail: String?, observedMessageId: String? = null): Boolean {
        if (id != requestId || viewGeneration != generation || state == "observed") return false
        if (next !in setOf("accepted", "delivered", "observed", "uncertain", "failed")) return false
        if (!pending && next in setOf("accepted", "delivered")) return false
        if (state == "delivered" && next == "accepted") return false
        state = next; error = detail
        // Only the Host may say which record this request became; a later
        // receipt never clears an identification already made.
        if (observedMessageId != null) messageId = observedMessageId
        if (next == "observed") {
            if (restored && text == submitted) text = ""
            restored = false
        } else if (next == "failed" && text.isEmpty()) {
            // Unknown writes are deliberately not put back in Send: the user must
            // inspect the terminal before choosing to manually send them again.
            text = submitted; restored = true
        }
        return true
    }

    fun disconnected(detail: String) {
        if (pending) receipt(requestId!!, generation, "uncertain", detail)
    }

    fun submittedText(): String = submitted
}

object AgentChatDrafts {
    private val drafts = LinkedHashMap<String, AgentChatDraft>(16, .75f, true)
    @Synchronized fun get(hostKey: String, sessionId: String): AgentChatDraft {
        val key = "$hostKey\u0000$sessionId"
        return drafts.getOrPut(key) { AgentChatDraft() }.also {
            if (drafts.size > 64) {
                val candidate = drafts.entries.firstOrNull { entry -> entry.key != key && !entry.value.pending }
                if (candidate != null) drafts.remove(candidate.key)
            }
        }
    }
}

/** Each connection and view owns its callbacks; stale sockets never change UI. */
class AgentChatEpoch {
    var connection = 0; private set
    var generation = 0; private set
    fun nextConnection(): Int { generation++; return ++connection }
    fun nextSubscription(): Int = ++generation
    fun accepts(connection: Int, conversationId: String?, expectedId: String, generation: Int?): Boolean =
        connection == this.connection && conversationId == expectedId && generation == this.generation
}
