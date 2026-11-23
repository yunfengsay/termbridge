package com.termbridge.android.watch

import android.content.Context
import androidx.core.content.edit
import com.termbridge.android.protocol.SessionInfo
import java.io.BufferedReader
import java.io.Closeable
import java.io.InputStreamReader
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Locale
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/**
 * Authenticated loopback bridge used by the TermBridge Zepp OS Side Service.
 *
 * The Zepp app and TermBridge are separate Android processes, so a loopback
 * endpoint is the smallest supported hand-off between them. The server never
 * binds Wi-Fi or cellular interfaces and the bearer only authorizes this
 * bounded status and short voice endpoints; it is not a relay or Host credential.
 */
class ZeppLocalBridge(
    private val expectedToken: () -> String,
    private val currentSnapshot: () -> ZeppBridgeSnapshot,
    private val submitVoice: ((ByteArray, String?) -> ZeppVoiceSnapshot)? = null,
    private val currentVoice: ((String) -> ZeppVoiceSnapshot?)? = null,
    private val decideVoice: ((String, ZeppVoiceDecision) -> ZeppVoiceSnapshot?)? = null,
    private val openSession: ((String) -> Boolean)? = null,
    private val submitAction: ((ZeppWatchAction, String) -> ZeppWatchActionSnapshot)? = null,
    private val currentAction: ((String) -> ZeppWatchActionSnapshot?)? = null,
    private val requestedPort: Int = PORT,
) : Closeable {
    private var server: ServerSocket? = null
    private var worker: ExecutorService? = null

    val boundPort: Int
        get() = server?.localPort ?: 0

    @Synchronized
    fun start(): Boolean {
        if (server != null) return true
        val socket = runCatching {
            ServerSocket().apply {
                reuseAddress = true
                bind(InetSocketAddress(InetAddress.getByName(LOOPBACK_IPV4), requestedPort), BACKLOG)
            }
        }.getOrNull() ?: return false
        server = socket
        ZeppBridgeRuntimeState.markRunning(socket.localPort)
        worker = Executors.newSingleThreadExecutor { task ->
            Thread(task, "termbridge-zepp-loopback").apply { isDaemon = true }
        }.also { executor -> executor.execute { acceptLoop(socket) } }
        return true
    }

    private fun acceptLoop(serverSocket: ServerSocket) {
        while (!serverSocket.isClosed) {
            val client = runCatching { serverSocket.accept() }.getOrNull() ?: break
            runCatching { handle(client) }
            runCatching { client.close() }
        }
    }

    private fun handle(client: Socket) {
        if (!client.inetAddress.isLoopbackAddress) return
        client.soTimeout = SOCKET_TIMEOUT_MS
        val reader = BufferedReader(InputStreamReader(client.getInputStream(), StandardCharsets.US_ASCII))
        val requestLine = reader.readLine()?.take(MAX_REQUEST_LINE) ?: return
        val headers = linkedMapOf<String, String>()
        var headerCount = 0
        while (headerCount++ < MAX_HEADERS) {
            val line = reader.readLine() ?: break
            if (line.isEmpty()) break
            val split = line.indexOf(':')
            if (split in 1..<line.length) {
                headers[line.substring(0, split).trim().lowercase(Locale.US)] = line.substring(split + 1).trim()
            }
        }
        val parts = requestLine.split(' ')
        if (parts.size < 2) return
        val method = parts[0]
        val path = parts[1].substringBefore('?')
        val supplied = headers["authorization"]?.removePrefix("Bearer ").orEmpty()
        if (!tokensEqual(expectedToken(), supplied)) {
            respond(client, 401, "Unauthorized", "{\"error\":\"unauthorized\"}")
            return
        }
        when {
            method == "GET" && path == STATUS_PATH -> respond(client, 200, "OK", currentSnapshot().toJson())
            method == "POST" && path == VOICE_PATH -> handleVoiceUpload(client, reader, headers)
            method == "GET" && path.startsWith("$VOICE_PATH/") -> handleVoiceStatus(client, path.removePrefix("$VOICE_PATH/"))
            method == "POST" && path == VOICE_DECISION_PATH -> handleVoiceDecision(client, headers)
            method == "POST" && path == OPEN_SESSION_PATH -> handleOpenSession(client, headers)
            method == "POST" && path == ACTION_PATH -> handleAction(client, headers)
            method == "GET" && path.startsWith("$ACTION_PATH/") -> handleActionStatus(client, path.removePrefix("$ACTION_PATH/"))
            else -> respond(client, 404, "Not Found", "{\"error\":\"not_found\"}")
        }
    }

    private fun handleOpenSession(client: Socket, headers: Map<String, String>) {
        val sessionId = headers[SOURCE_SESSION_HEADER]
            ?.takeIf { it.isNotBlank() && it.length <= MAX_SOURCE_SESSION_ID_CHARS && it.none(Char::isISOControl) }
            ?: run {
                respond(client, 400, "Bad Request", "{\"error\":\"invalid_session\"}")
                return
            }
        val handoff = openSession ?: run {
            respond(client, 503, "Service Unavailable", "{\"error\":\"handoff_unavailable\"}")
            return
        }
        if (runCatching { handoff(sessionId) }.getOrDefault(false)) {
            respond(client, 202, "Accepted", "{\"version\":1,\"opened\":true}")
        } else {
            respond(client, 503, "Service Unavailable", "{\"error\":\"handoff_unavailable\"}")
        }
    }

    private fun handleAction(client: Socket, headers: Map<String, String>) {
        val sessionId = headers[SOURCE_SESSION_HEADER]
            ?.takeIf { it.isNotBlank() && it.length <= MAX_SOURCE_SESSION_ID_CHARS && it.none(Char::isISOControl) }
            ?: run {
                respond(client, 400, "Bad Request", "{\"error\":\"invalid_session\"}")
                return
            }
        val action = ZeppWatchAction.fromWireName(headers[ACTION_HEADER].orEmpty()) ?: run {
            respond(client, 400, "Bad Request", "{\"error\":\"invalid_action\"}")
            return
        }
        val submit = submitAction ?: run {
            respond(client, 503, "Service Unavailable", "{\"error\":\"action_unavailable\"}")
            return
        }
        try {
            respond(client, 202, "Accepted", submit(action, sessionId).toJson())
        } catch (error: VoiceUnavailableException) {
            respond(client, 503, "Service Unavailable", "{\"error\":${error.message.orEmpty().jsonQuoted()}}")
        } catch (_: IllegalArgumentException) {
            respond(client, 400, "Bad Request", "{\"error\":\"invalid_action\"}")
        } catch (_: Exception) {
            respond(client, 500, "Internal Server Error", "{\"error\":\"action_failed\"}")
        }
    }

    private fun handleActionStatus(client: Socket, actionId: String) {
        if (!VOICE_ID.matches(actionId)) {
            respond(client, 404, "Not Found", "{\"error\":\"not_found\"}")
            return
        }
        val action = currentAction?.invoke(actionId)
        if (action == null) respond(client, 404, "Not Found", "{\"error\":\"not_found\"}")
        else respond(client, 200, "OK", action.toJson())
    }

    private fun handleVoiceUpload(client: Socket, reader: BufferedReader, headers: Map<String, String>) {
        val submit = submitVoice ?: run {
            respond(client, 503, "Service Unavailable", "{\"error\":\"voice_unavailable\"}")
            return
        }
        val length = headers["content-length"]?.toIntOrNull()
        if (length == null || length !in 1..MAX_VOICE_BODY_CHARS) {
            respond(client, 413, "Content Too Large", "{\"error\":\"invalid_audio\"}")
            return
        }
        val body = CharArray(length)
        var offset = 0
        while (offset < body.size) {
            val count = reader.read(body, offset, body.size - offset)
            if (count < 0) break
            offset += count
        }
        if (offset != body.size) {
            respond(client, 400, "Bad Request", "{\"error\":\"invalid_audio\"}")
            return
        }
        val audio = decodeBase64(String(body))
        if (audio == null) {
            respond(client, 400, "Bad Request", "{\"error\":\"invalid_audio\"}")
            return
        }
        try {
            val sourceSessionId = headers[SOURCE_SESSION_HEADER]
                ?.takeIf { it.length <= MAX_SOURCE_SESSION_ID_CHARS && it.none(Char::isISOControl) }
            respond(client, 202, "Accepted", submit(audio, sourceSessionId).toJson())
        } catch (_: VoiceBusyException) {
            respond(client, 409, "Conflict", "{\"error\":\"voice_busy\"}")
        } catch (error: VoiceUnavailableException) {
            respond(client, 503, "Service Unavailable", "{\"error\":${error.message.orEmpty().jsonQuoted()}}")
        } catch (_: IllegalArgumentException) {
            respond(client, 400, "Bad Request", "{\"error\":\"invalid_audio\"}")
        } catch (_: Exception) {
            respond(client, 500, "Internal Server Error", "{\"error\":\"voice_failed\"}")
        }
    }

    private fun handleVoiceStatus(client: Socket, voiceId: String) {
        if (!VOICE_ID.matches(voiceId)) {
            respond(client, 404, "Not Found", "{\"error\":\"not_found\"}")
            return
        }
        val voice = currentVoice?.invoke(voiceId)
        if (voice == null) {
            respond(client, 404, "Not Found", "{\"error\":\"not_found\"}")
        } else {
            respond(client, 200, "OK", voice.toJson())
        }
    }

    private fun handleVoiceDecision(client: Socket, headers: Map<String, String>) {
        val voiceId = headers[VOICE_ID_HEADER].orEmpty()
        if (!VOICE_ID.matches(voiceId)) {
            respond(client, 400, "Bad Request", "{\"error\":\"invalid_voice_id\"}")
            return
        }
        val decision = ZeppVoiceDecision.fromWireName(headers[VOICE_DECISION_HEADER].orEmpty()) ?: run {
            respond(client, 400, "Bad Request", "{\"error\":\"invalid_decision\"}")
            return
        }
        val decide = decideVoice ?: run {
            respond(client, 503, "Service Unavailable", "{\"error\":\"voice_unavailable\"}")
            return
        }
        try {
            val snapshot = decide(voiceId, decision)
            if (snapshot == null) respond(client, 404, "Not Found", "{\"error\":\"not_found\"}")
            else respond(client, 202, "Accepted", snapshot.toJson())
        } catch (error: VoiceDecisionException) {
            respond(client, 409, "Conflict", "{\"error\":${error.message.orEmpty().jsonQuoted()}}")
        } catch (_: Exception) {
            respond(client, 500, "Internal Server Error", "{\"error\":\"voice_failed\"}")
        }
    }

    private fun respond(client: Socket, status: Int, reason: String, body: String) {
        val bytes = body.toByteArray(StandardCharsets.UTF_8)
        val head = buildString {
            append("HTTP/1.1 ").append(status).append(' ').append(reason).append("\r\n")
            append("Content-Type: application/json; charset=utf-8\r\n")
            append("Content-Length: ").append(bytes.size).append("\r\n")
            append("Cache-Control: no-store\r\n")
            append("Connection: close\r\n\r\n")
        }.toByteArray(StandardCharsets.US_ASCII)
        client.getOutputStream().apply {
            write(head)
            write(bytes)
            flush()
        }
    }

    override fun close() {
        val activeServer = synchronized(this) {
            server.also { server = null }
        }
        runCatching { activeServer?.close() }
        ZeppBridgeRuntimeState.markStopped()
        worker?.shutdownNow()
        worker = null
    }

    companion object {
        const val PORT = 47_391
        const val STATUS_PATH = "/v1/status"
        const val VOICE_PATH = "/v1/voice"
        const val VOICE_DECISION_PATH = "/v1/voice-decision"
        const val OPEN_SESSION_PATH = "/v1/open-session"
        const val ACTION_PATH = "/v1/action"
        internal const val LOOPBACK_IPV4 = "127.0.0.1"
        private const val BACKLOG = 4
        private const val MAX_HEADERS = 32
        private const val MAX_REQUEST_LINE = 2_048
        private const val SOCKET_TIMEOUT_MS = 3_000
        private const val MAX_VOICE_BODY_CHARS = 1_400_000
        private const val MAX_SOURCE_SESSION_ID_CHARS = 256
        private const val SOURCE_SESSION_HEADER = "x-termbridge-source-session"
        private const val ACTION_HEADER = "x-termbridge-action"
        private const val VOICE_ID_HEADER = "x-termbridge-voice-id"
        private const val VOICE_DECISION_HEADER = "x-termbridge-voice-decision"
        private val VOICE_ID = Regex("[0-9a-fA-F-]{36}")

        internal fun tokensEqual(expected: String, supplied: String): Boolean =
            expected.isNotEmpty() && MessageDigest.isEqual(
                expected.toByteArray(StandardCharsets.US_ASCII),
                supplied.toByteArray(StandardCharsets.US_ASCII),
            )

        internal fun decodeBase64(value: String): ByteArray? {
            if (value.isEmpty() || value.length % 4 != 0) return null
            val padding = when {
                value.endsWith("==") -> 2
                value.endsWith('=') -> 1
                else -> 0
            }
            val output = ByteArray(value.length / 4 * 3 - padding)
            var inputOffset = 0
            var outputOffset = 0
            while (inputOffset < value.length) {
                val a = base64Value(value[inputOffset++]) ?: return null
                val b = base64Value(value[inputOffset++]) ?: return null
                val cChar = value[inputOffset++]
                val dChar = value[inputOffset++]
                val c = if (cChar == '=') 0 else base64Value(cChar) ?: return null
                val d = if (dChar == '=') 0 else base64Value(dChar) ?: return null
                if ((cChar == '=' && dChar != '=') || (cChar == '=' && inputOffset != value.length) ||
                    (dChar == '=' && inputOffset != value.length)
                ) return null
                if (outputOffset < output.size) output[outputOffset++] = ((a shl 2) or (b shr 4)).toByte()
                if (outputOffset < output.size) output[outputOffset++] = (((b and 15) shl 4) or (c shr 2)).toByte()
                if (outputOffset < output.size) output[outputOffset++] = (((c and 3) shl 6) or d).toByte()
            }
            return output
        }

        private fun base64Value(character: Char): Int? = when (character) {
            in 'A'..'Z' -> character.code - 'A'.code
            in 'a'..'z' -> character.code - 'a'.code + 26
            in '0'..'9' -> character.code - '0'.code + 52
            '+' -> 62
            '/' -> 63
            else -> null
        }
    }
}

object ZeppBridgeRuntimeState {
    @Volatile private var port: Int = 0

    fun boundPort(): Int = port
    fun isRunning(): Boolean = port > 0
    internal fun markRunning(value: Int) { port = value.coerceAtLeast(0) }
    internal fun markStopped() { port = 0 }
}

object ZeppBridgeTokenStore {
    private const val PREFERENCES = "termbridge_zepp_bridge"
    private const val TOKEN = "status_token"
    private const val TOKEN_BYTES = 24

    @Synchronized
    fun getOrCreate(context: Context): String {
        val preferences = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
        preferences.getString(TOKEN, null)?.takeIf(::isValid)?.let { return it }
        val token = generateToken()
        preferences.edit(commit = true) { putString(TOKEN, token) }
        return token
    }

    internal fun generateToken(random: SecureRandom = SecureRandom()): String {
        val bytes = ByteArray(TOKEN_BYTES).also(random::nextBytes)
        return buildString(bytes.size * 2) {
            bytes.forEach { append("%02x".format(Locale.US, it.toInt() and 0xff)) }
        }
    }

    fun normalize(value: String): String = value.filter(Char::isLetterOrDigit).lowercase(Locale.US)

    fun display(value: String): String = normalize(value).chunked(4).joinToString("-")

    fun isValid(value: String): Boolean = normalize(value).matches(Regex("[0-9a-f]{48}"))
}

data class ZeppBridgeAgent(
    val sessionId: String,
    val title: String,
    val summary: String,
    val status: String,
    val priority: Int,
)

data class ZeppBridgeAlert(
    val id: String,
    val sessionId: String,
    val title: String,
    val summary: String,
    val status: String,
    val occurredAt: Long,
) {
    companion object {
        fun fromSession(session: SessionInfo, status: String, occurredAt: Long): ZeppBridgeAlert = ZeppBridgeAlert(
            id = "$occurredAt:${session.sessionId}:$status".take(384),
            sessionId = session.sessionId.take(256),
            title = session.displayName.take(96),
            summary = (session.preview ?: session.command).take(240),
            status = status.take(32),
            occurredAt = occurredAt.coerceAtLeast(0L),
        )
    }
}

data class ZeppBridgeSnapshot(
    val connected: Boolean,
    val host: String,
    val updatedAt: Long,
    val agents: List<ZeppBridgeAgent>,
    val alerts: List<ZeppBridgeAlert> = emptyList(),
) {
    fun toJson(): String = buildString {
        append("{\"version\":1,\"connected\":").append(connected)
        append(",\"host\":").append(host.jsonQuoted())
        append(",\"updatedAt\":").append(updatedAt.coerceAtLeast(0L))
        append(",\"counts\":{")
        append("\"attention\":").append(agents.count { it.priority == 0 })
        append(",\"working\":").append(agents.count { it.priority == 1 })
        append(",\"total\":").append(agents.size)
        append(",\"alerts\":").append(alerts.size).append('}')
        append(",\"agents\":[")
        agents.forEachIndexed { index, agent ->
            if (index > 0) append(',')
            append("{\"sessionId\":").append(agent.sessionId.jsonQuoted())
            append(",\"title\":").append(agent.title.jsonQuoted())
            append(",\"summary\":").append(agent.summary.jsonQuoted())
            append(",\"status\":").append(agent.status.jsonQuoted())
            append(",\"priority\":").append(agent.priority).append('}')
        }
        append("],\"alerts\":[")
        alerts.forEachIndexed { index, alert ->
            if (index > 0) append(',')
            append("{\"id\":").append(alert.id.jsonQuoted())
            append(",\"sessionId\":").append(alert.sessionId.jsonQuoted())
            append(",\"title\":").append(alert.title.jsonQuoted())
            append(",\"summary\":").append(alert.summary.jsonQuoted())
            append(",\"status\":").append(alert.status.jsonQuoted())
            append(",\"occurredAt\":").append(alert.occurredAt).append('}')
        }
        append("]}")
    }

    companion object {
        fun fromSessions(
            connected: Boolean,
            host: String,
            sessions: List<SessionInfo>,
            now: Long,
            alerts: List<ZeppBridgeAlert> = emptyList(),
        ): ZeppBridgeSnapshot {
            val agents = sessions.asSequence()
                .map { session ->
                    val status = session.status.orEmpty().ifBlank { if (session.isActive) "active" else "idle" }
                    ZeppBridgeAgent(
                        sessionId = session.sessionId.take(256),
                        title = session.displayName.take(96),
                        summary = (session.preview ?: session.command).take(240),
                        status = status.take(32),
                        priority = statusPriority(status),
                    )
                }
                .sortedWith(compareBy<ZeppBridgeAgent> { it.priority }.thenBy { it.title })
                .take(MAX_AGENTS)
                .toList()
            return ZeppBridgeSnapshot(
                connected = connected,
                host = host.take(96),
                updatedAt = now.coerceAtLeast(0L),
                agents = agents,
                alerts = alerts.take(MAX_ALERTS),
            )
        }

        private fun statusPriority(status: String): Int = when (status.lowercase(Locale.US)) {
            "waiting", "approval", "blocked" -> 0
            "working", "running", "active" -> 1
            else -> 2
        }

        private const val MAX_AGENTS = 24
        private const val MAX_ALERTS = 16
    }
}

object ZeppBridgeStateStore {
    @Volatile
    private var value = ZeppBridgeSnapshot(false, "TermBridge", 0L, emptyList())

    fun snapshot(): ZeppBridgeSnapshot = value

    @Synchronized
    fun updateConnection(connected: Boolean, host: String, now: Long = System.currentTimeMillis()) {
        value = value.copy(connected = connected, host = host.take(96), updatedAt = now.coerceAtLeast(0L))
    }

    @Synchronized
    fun updateSessions(connected: Boolean, host: String, sessions: List<SessionInfo>, now: Long = System.currentTimeMillis()) {
        value = ZeppBridgeSnapshot.fromSessions(connected, host, sessions, now, value.alerts)
    }

    @Synchronized
    fun appendAlert(alert: ZeppBridgeAlert) {
        val alerts = buildList {
            add(alert)
            value.alerts.filterTo(this) { it.id != alert.id }
        }.take(16)
        value = value.copy(updatedAt = maxOf(value.updatedAt, alert.occurredAt), alerts = alerts)
    }

    @Synchronized
    fun replaceAlerts(alerts: List<ZeppBridgeAlert>) {
        value = value.copy(alerts = alerts.take(16))
    }
}

internal fun String.jsonQuoted(): String = buildString(length + 2) {
    append('"')
    for (character in this@jsonQuoted) {
        when (character) {
            '"' -> append("\\\"")
            '\\' -> append("\\\\")
            '\b' -> append("\\b")
            '\u000c' -> append("\\f")
            '\n' -> append("\\n")
            '\r' -> append("\\r")
            '\t' -> append("\\t")
            else -> if (character.code < 0x20) append("\\u%04x".format(Locale.US, character.code)) else append(character)
        }
    }
    append('"')
}
