package com.termbridge.android.network

import android.content.Context
import com.termbridge.android.R
import com.termbridge.android.data.ConnectionSettings
import com.termbridge.android.protocol.ControlMessage
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.URI
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit
import javax.net.SocketFactory

/**
 * Step-by-step reachability for the connection form: each network path, the password-free
 * HTTP check, then the real WebSocket login and session list. Blocking; never saves the profile.
 */
object ConnectionCheck {
    fun run(context: Context, settings: ConnectionSettings): List<String> {
        val uri = runCatching { URI(settings.relayUrl.trim()) }.getOrNull()
        val host = uri?.host ?: return listOf(context.getString(R.string.connection_test_ws_failed, "invalid address"))
        val port = uri.port.takeIf { it > 0 } ?: if (uri.scheme == "wss") 443 else 80
        val lines = mutableListOf<String>()
        if (settings.isDirectConnection) {
            val results = LanRoutes.probeAll(context, host, port, uri.scheme == "wss", uri.rawPath.orEmpty().ifEmpty { "/" })
            lines += context.getString(R.string.connection_test_routes, "$host:$port")
            results.forEach { lines += "• " + LanRoutes.describe(context, it) }
            val reachable = results.firstOrNull { it.connected }
            if (reachable == null) {
                lines += context.getString(R.string.connection_test_unreachable)
                return lines
            }
            if (!results.first().connected) lines += context.getString(R.string.connection_test_rerouted, reachable.route.label)
            if (uri.scheme == "ws") lines += httpCheck(context, reachable.route, host, port)
        }
        lines += handshake(context, settings)
        return lines
    }

    private fun httpCheck(context: Context, route: LanRoute, host: String, port: Int): String = try {
        (route.network?.socketFactory ?: SocketFactory.getDefault()).createSocket().use { socket ->
            socket.connect(InetSocketAddress(route.network?.getByName(host) ?: InetAddress.getByName(host), port), 3_000)
            socket.soTimeout = 3_000
            socket.getOutputStream().write(
                "HEAD /.well-known/termbridge HTTP/1.1\r\nHost: $host:$port\r\nConnection: close\r\n\r\n".toByteArray())
            val head = socket.getInputStream().bufferedReader(Charsets.ISO_8859_1).lineSequence()
                .takeWhile { it.isNotEmpty() }.toList()
            val status = head.firstOrNull()?.split(' ')?.getOrNull(1)?.toIntOrNull()
                ?: return context.getString(R.string.connection_test_http_failed, "invalid response")
            val identified = status == 200 && head.any {
                it.substringBefore(':').trim().equals("X-TermBridge-Service", ignoreCase = true) &&
                    it.substringAfter(':').trim() == "relay-v1"
            }
            context.getString(if (identified) R.string.connection_test_http_ok else R.string.connection_test_http_other, status)
        }
    } catch (error: Exception) {
        context.getString(R.string.connection_test_http_failed, error.message ?: error.javaClass.simpleName)
    }

    /** The same authentication a real connection performs, ending at the selected Host's session list. */
    private fun handshake(context: Context, settings: ConnectionSettings): String {
        val outcome = CompletableFuture<String>()
        var hostName = ""
        lateinit var client: TermbridgeClient
        client = TermbridgeClient(settings, object : TermbridgeClient.Listener {
            override fun onConnectionState(state: ConnectionState) {
                if (state is ConnectionState.Failed) outcome.complete(context.getString(R.string.connection_test_ws_failed, state.message))
                if (state == ConnectionState.Disconnected) outcome.complete(context.getString(R.string.connection_test_ws_failed, "disconnected"))
            }
            override fun onReady(client: TermbridgeClient) = Unit
            override fun onControl(message: ControlMessage) {
                when (message.type) {
                    "host_list_result" -> {
                        val selected = message.string("selectedHostId") ?: settings.hostId
                        val host = message.hosts().firstOrNull { it.hostId == selected }
                        if (host == null) outcome.complete(context.getString(R.string.connection_test_host_missing))
                        else { hostName = host.name; client.sendControl("t" to "session_list") }
                    }
                    "session_list_result" -> outcome.complete(context.getString(R.string.connection_test_ws_ok, hostName, message.sessions().size))
                    "error" -> outcome.complete(context.getString(R.string.connection_test_ws_failed, message.string("message") ?: "error"))
                }
            }
            override fun onPtyOutput(sid: Int, data: ByteArray) = Unit
        }, context = context)
        client.connect()
        return try {
            outcome.get(20, TimeUnit.SECONDS)
        } catch (_: Exception) {
            context.getString(R.string.connection_test_ws_failed, context.getString(R.string.connection_test_timeout))
        } finally {
            client.disconnect()
        }
    }
}
