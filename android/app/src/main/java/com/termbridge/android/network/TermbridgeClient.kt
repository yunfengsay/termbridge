package com.termbridge.android.network

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.os.Build
import com.termbridge.android.data.TrafficSettings
import com.termbridge.android.brain.VoiceAppVisibility
import com.termbridge.android.protocol.ClientStreamPolicy
import com.termbridge.android.data.ConnectionSettings
import com.termbridge.android.data.PairingCode
import com.termbridge.android.protocol.ControlMessage
import com.termbridge.android.protocol.FrameCodec
import com.termbridge.android.protocol.IncomingFrame
import com.termbridge.android.protocol.HostNetworkPolicy
import com.termbridge.android.peer.AndroidPeerTools
import com.termbridge.android.peer.PeerToolResult
import com.termbridge.android.security.Hmac
import okhttp3.OkHttpClient
import okhttp3.Dns
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import java.util.concurrent.TimeUnit

sealed interface ConnectionState {
    data object Connecting : ConnectionState
    data object Authenticating : ConnectionState
    data object Connected : ConnectionState
    data object Disconnected : ConnectionState
    data class Failed(val message: String) : ConnectionState
}

class TermbridgeClient(
    private val settings: ConnectionSettings,
    private val listener: Listener,
    private val backgroundMonitor: Boolean = false,
    context: Context? = null,
) {
    interface Listener {
        fun onConnectionState(state: ConnectionState)
        fun onReady(client: TermbridgeClient)
        fun onControl(message: ControlMessage)
        fun onPtyOutput(sid: Int, data: ByteArray)
    }

    private val httpClient: OkHttpClient
    private val appContext = context?.applicationContext ?: (listener as? Context)?.applicationContext
    @Volatile private var webSocket: WebSocket? = null
    @Volatile private var ready = false
    @Volatile var backgroundTrafficAcknowledged = false
        private set
    private var requestedBackground: Boolean? = null
    private var wantsBrainSnapshot = false
    private val visibilityListener: (Boolean) -> Unit = { updateTrafficPolicy() }
    private val trafficListener: () -> Unit = { updateTrafficPolicy() }

    @Synchronized private fun updateTrafficPolicy() {
        val context = appContext ?: return
        if (!ready) return
        val background = TrafficSettings.enabled(context) &&
            (backgroundMonitor || !VoiceAppVisibility.isForeground())
        if (requestedBackground == background || (requestedBackground == null && !background)) return
        requestedBackground = background
        sendControl("t" to ClientStreamPolicy.REQUEST, "background" to background,
            "notifications" to backgroundMonitor)
    }

    @Synchronized private fun releaseTrafficListeners() {
        ready = false
        backgroundTrafficAcknowledged = false
        requestedBackground = null
        TrafficSettings.removeListener(trafficListener)
        VoiceAppVisibility.removeListener(visibilityListener)
    }
    @Volatile private var closedByClient = false

    init {
        val builder = OkHttpClient.Builder()
            .connectTimeout(12, TimeUnit.SECONDS)
            .pingInterval(30, TimeUnit.SECONDS)
            .retryOnConnectionFailure(true)
        val localEndpoint = settings.bypassesAppProxy
        if (localEndpoint) builder.proxy(java.net.Proxy.NO_PROXY)
        if (settings.isDirectConnection && appContext != null) {
            runCatching { java.net.URI(settings.relayUrl.trim()) }.getOrNull()?.takeIf { it.host != null }?.let { uri ->
                val port = uri.port.takeIf { it > 0 } ?: if (uri.scheme == "wss") 443 else 80
                builder.socketFactory(DirectRouteSocketFactory(appContext, uri.host, port, uri.scheme == "wss",
                    uri.rawPath.orEmpty().ifEmpty { "/" } + (uri.rawQuery?.let { "?$it" } ?: "")))
            }
        }
        if (!localEndpoint && settings.networkPolicy == HostNetworkPolicy.DIRECT && appContext != null) {
            directNetwork(appContext)?.let { network ->
                // Socket-level binding avoids changing the process-wide route.
                // Android honours it only when the active VPN allows bypass.
                builder.socketFactory(network.socketFactory)
                builder.dns(Dns { hostname -> network.getAllByName(hostname).toList() })
            }
        }
        if (settings.relayUrl.startsWith("wss://", ignoreCase = true) && settings.normalizedFingerprint.isNotBlank()) {
            PinnedTls.apply(builder, settings.normalizedFingerprint)
        }
        httpClient = builder.build()
    }

    @Suppress("DEPRECATION")
    private fun directNetwork(context: Context): Network? {
        val connectivity = context.getSystemService(ConnectivityManager::class.java)
        return connectivity.allNetworks
            .mapNotNull { network ->
                val capabilities = connectivity.getNetworkCapabilities(network) ?: return@mapNotNull null
                if (!capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) ||
                    capabilities.hasTransport(NetworkCapabilities.TRANSPORT_VPN)
                ) {
                    return@mapNotNull null
                }
                val score = when {
                    capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED) &&
                        capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> 4
                    capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED) -> 3
                    capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> 2
                    else -> 1
                }
                network to score
            }
            .maxByOrNull { it.second }
            ?.first
    }

    fun connect() {
        if (webSocket != null) return
        closedByClient = false
        TrafficSettings.addListener(trafficListener)
        VoiceAppVisibility.addListener(visibilityListener)
        listener.onConnectionState(ConnectionState.Connecting)
        val request = runCatching {
            Request.Builder()
                .url(settings.relayUrl.trim())
                .apply {
                    if (PairingCode.isHostedRoom(settings.relayUrl) && settings.secret.isNotBlank()) {
                        header(PairingCode.ROOM_KEY_HEADER, settings.secret)
                    }
                }
                .build()
        }
            .getOrElse {
                releaseTrafficListeners()
                listener.onConnectionState(ConnectionState.Failed(it.message ?: "Invalid relay URL"))
                return
            }
        val socketListener = SocketListener()
        webSocket = httpClient.newWebSocket(request, socketListener)
    }

    fun disconnect() {
        releaseTrafficListeners()
        closedByClient = true
        val socket = webSocket
        webSocket = null
        socket?.close(1000, "client leaving")
        httpClient.dispatcher.cancelAll()
    }

    fun sendControl(vararg fields: Pair<String, Any?>): Boolean {
        val type = fields.firstOrNull { it.first == "t" }?.second
        if (type == "brain_snapshot") wantsBrainSnapshot = true
        if (backgroundTrafficAcknowledged && (type == "brain_snapshot" || type == "session_list")) return true
        return send(FrameCodec.control(*fields))
    }

    fun sendPtyInput(sid: Int, bytes: ByteArray): Boolean =
        bytes.isNotEmpty() && send(FrameCodec.ptyInput(sid, bytes))

    fun sendResize(sid: Int, cols: Int, rows: Int): Boolean =
        send(FrameCodec.resize(sid, cols.coerceAtLeast(2), rows.coerceAtLeast(2)))

    private fun send(frame: ByteArray): Boolean = webSocket?.send(ByteString.of(*frame)) == true

    private inner class SocketListener : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) {
            if (this@TermbridgeClient.webSocket !== webSocket) return
            listener.onConnectionState(ConnectionState.Authenticating)
        }

        override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
            if (this@TermbridgeClient.webSocket !== webSocket) return
            val frame = runCatching { FrameCodec.decode(bytes.toByteArray()) }
                .getOrElse {
                    fail(webSocket, "Protocol error: ${it.message ?: "invalid frame"}")
                    return
                }
            when (frame) {
                is IncomingFrame.Control -> handleControl(webSocket, frame.message)
                is IncomingFrame.PtyOutput -> listener.onPtyOutput(frame.sid, frame.data)
                else -> Unit
            }
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            if (this@TermbridgeClient.webSocket === webSocket) fail(webSocket, "Relay sent a text frame")
        }

        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            // Echo the close handshake, but never with a reserved code: OkHttp
            // reports 1005/1006/1015 when the peer sent none, and close() throws
            // on them — the IllegalArgumentException then masks the real reason
            // (e.g. the relay's "host not found") behind "Code 1005 is reserved".
            val sendable = code == 1000 || code in 1001..1003 || code in 1007..1011 || code in 3000..4999
            webSocket.close(if (sendable) code else 1000, null)
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
            if (this@TermbridgeClient.webSocket !== webSocket) return
            releaseTrafficListeners()
            this@TermbridgeClient.webSocket = null
            if (!closedByClient) listener.onConnectionState(ConnectionState.Disconnected)
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            if (this@TermbridgeClient.webSocket !== webSocket) return
            releaseTrafficListeners()
            this@TermbridgeClient.webSocket = null
            if (!closedByClient) {
                val detail = t.message?.takeIf(String::isNotBlank) ?: t.javaClass.simpleName
                listener.onConnectionState(ConnectionState.Failed(detail))
            }
        }

        private fun handleControl(webSocket: WebSocket, message: ControlMessage) {
            if (message.type == ClientStreamPolicy.RESULT) {
                val wasBackground = backgroundTrafficAcknowledged
                backgroundTrafficAcknowledged = message.boolean("background") == true
                if (wasBackground && !backgroundTrafficAcknowledged && wantsBrainSnapshot) {
                    sendControl("t" to "brain_snapshot")
                }
            }
            if (message.type == "tool_request" && appContext != null) {
                val id = message.string("id") ?: return
                AndroidPeerTools.execute(appContext, message) { result ->
                    sendToolResponse(id, result)
                }
                return
            }
            if (message.type != "auth_challenge") {
                listener.onControl(message)
                return
            }
            if (message.boolean("required") == true && settings.secret.isEmpty()) {
                fail(webSocket, "This relay requires its shared password")
                return
            }
            val nonce = message.string("nonce")
            if (nonce.isNullOrBlank()) {
                fail(webSocket, "Relay sent an invalid authentication challenge")
                return
            }
            webSocket.send(
                ByteString.of(
                    *FrameCodec.control(
                        "t" to "auth_response",
                        "mac" to Hmac.sha256Hex(settings.secret, nonce),
                    ),
                ),
            )
            webSocket.send(
                ByteString.of(
                    *FrameCodec.control(
                        "t" to "hello",
                        "role" to "client",
                        "hostId" to settings.hostId.trim(),
                        "name" to "Android ${Build.MODEL}",
                        "wantsHosts" to true,
                    ),
                ),
            )
            listener.onConnectionState(ConnectionState.Connected)
            ready = true
            updateTrafficPolicy()
            listener.onReady(this@TermbridgeClient)
        }

        private fun sendToolResponse(id: String, result: PeerToolResult) {
            sendControl(
                "t" to "tool_response",
                "id" to id,
                "ok" to result.ok,
                "exit" to result.exit,
                "stdout" to result.stdout,
                "stderr" to result.stderr,
                "data" to result.data,
                "error" to result.error,
            )
        }

        private fun fail(webSocket: WebSocket, message: String) {
            releaseTrafficListeners()
            listener.onConnectionState(ConnectionState.Failed(message))
            closedByClient = true
            this@TermbridgeClient.webSocket = null
            webSocket.close(1002, closeReason(message))
        }

        // Close reasons are capped at 123 UTF-8 bytes; longer ones make close() throw.
        private fun closeReason(message: String): String {
            var reason = message.take(123)
            while (reason.toByteArray(Charsets.UTF_8).size > 123) reason = reason.dropLast(1)
            return reason
        }
    }
}
