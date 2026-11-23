package com.termbridge.android.network

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.os.SystemClock
import android.util.Base64
import com.termbridge.android.R
import java.io.EOFException
import java.io.IOException
import java.net.ConnectException
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.Socket
import java.security.SecureRandom
import java.util.Collections
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import javax.net.SocketFactory
import kotlin.concurrent.thread

/** One way out of the phone: the default route (`network == null`) or one physical network. */
data class LanRoute(val label: String, val network: Network?)

/** `connected` means the server itself answered; `accepted` means only the TCP handshake completed. */
data class LanRouteResult(
    val route: LanRoute,
    val connected: Boolean,
    val millis: Long,
    val localAddress: String? = null,
    val error: String? = null,
    val reply: String? = null,
    val accepted: Boolean = false,
)

/**
 * A VPN can own the default route without reaching a LAN host (a proxy VPN on office Wi-Fi),
 * or be the only way to reach it (a corporate VPN away from the office). Direct connections
 * therefore race the default route against each physical network and use the first whose server answers.
 */
object LanRoutes {
    const val PROBE_TIMEOUT_MS = 5_000

    @Suppress("DEPRECATION")
    fun candidates(context: Context): List<LanRoute> {
        val connectivity = context.getSystemService(ConnectivityManager::class.java)
        val defaultCapabilities = connectivity.activeNetwork?.let(connectivity::getNetworkCapabilities)
        val vpnDefault = defaultCapabilities?.hasTransport(NetworkCapabilities.TRANSPORT_VPN) == true
        val routes = mutableListOf(LanRoute(context.getString(label(defaultCapabilities)), null))
        // Without a VPN the default route already is the physical network.
        if (!vpnDefault) return routes
        for (network in connectivity.allNetworks) {
            val capabilities = connectivity.getNetworkCapabilities(network) ?: continue
            if (capabilities.hasTransport(NetworkCapabilities.TRANSPORT_VPN)) continue
            routes += LanRoute(context.getString(label(capabilities)), network)
        }
        return routes
    }

    private fun label(capabilities: NetworkCapabilities?): Int = when {
        capabilities == null -> R.string.lan_route_default
        capabilities.hasTransport(NetworkCapabilities.TRANSPORT_VPN) -> R.string.lan_route_vpn
        capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> R.string.lan_route_wifi
        capabilities.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> R.string.lan_route_cellular
        capabilities.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> R.string.lan_route_ethernet
        else -> R.string.lan_route_other
    }

    /**
     * A route counts only when the server itself answers: the status line of a WebSocket upgrade,
     * or a completed TLS handshake. A VPN that accepts TCP on the phone but cannot deliver fails
     * here instead of winning the race. Binding fails here when the VPN forbids bypass.
     */
    fun probe(route: LanRoute, host: String, port: Int, secure: Boolean, path: String = "/",
              timeoutMs: Int = PROBE_TIMEOUT_MS): LanRouteResult {
        val started = SystemClock.elapsedRealtime()
        fun elapsed() = SystemClock.elapsedRealtime() - started
        var accepted = false
        var local: String? = null
        return try {
            (route.network?.socketFactory ?: SocketFactory.getDefault()).createSocket().use { socket ->
                socket.connect(InetSocketAddress(route.network?.getByName(host) ?: InetAddress.getByName(host), port), timeoutMs)
                accepted = true; local = socket.localAddress?.hostAddress
                socket.soTimeout = (timeoutMs - elapsed()).toInt().coerceAtLeast(500)
                val reply = if (secure) { LanConnection.handshake(socket, host, port).close(); "TLS" }
                    else upgradeStatus(socket, host, port, path)
                LanRouteResult(route, true, elapsed(), local, reply = reply)
            }
        } catch (error: Exception) {
            LanRouteResult(route, false, elapsed(), local,
                error = error.message?.takeIf(String::isNotBlank) ?: error.javaClass.simpleName, accepted = accepted)
        }
    }

    /** Every TermBridge relay answers an upgrade, old or new; the socket closes before authentication. */
    private fun upgradeStatus(socket: Socket, host: String, port: Int, path: String): String {
        val key = Base64.encodeToString(ByteArray(16).also { SecureRandom().nextBytes(it) }, Base64.NO_WRAP)
        socket.getOutputStream().write(("GET $path HTTP/1.1\r\nHost: $host:$port\r\nUpgrade: websocket\r\n" +
            "Connection: Upgrade\r\nSec-WebSocket-Key: $key\r\nSec-WebSocket-Version: 13\r\n\r\n").toByteArray())
        val line = socket.getInputStream().bufferedReader(Charsets.ISO_8859_1).readLine()
            ?: throw EOFException("closed without a response")
        return "HTTP " + (httpStatus(line) ?: throw IOException("not an HTTP response"))
    }

    /** The status code of an HTTP/1.x status line, or null. */
    fun httpStatus(line: String): Int? = Regex("^HTTP/1\\.[01] (\\d{3})(?: |$)").find(line)?.groupValues?.get(1)?.toInt()

    /** Every route's result, probed concurrently, for diagnostics. */
    fun probeAll(context: Context, host: String, port: Int, secure: Boolean, path: String): List<LanRouteResult> {
        val routes = candidates(context)
        val results = arrayOfNulls<LanRouteResult>(routes.size)
        routes.mapIndexed { index, route -> thread(isDaemon = true) { results[index] = probe(route, host, port, secure, path) } }
            .forEach { it.join(PROBE_TIMEOUT_MS + 2_000L) }
        return routes.mapIndexed { index, route ->
            results[index] ?: LanRouteResult(route, false, PROBE_TIMEOUT_MS.toLong(), error = "timeout")
        }
    }

    /** The first route to connect wins; slower probes finish and close on their own threads. */
    fun race(routes: List<LanRoute>, probe: (LanRoute) -> LanRouteResult): Pair<LanRouteResult?, List<LanRouteResult>> {
        val results = Collections.synchronizedList(mutableListOf<LanRouteResult>())
        val winner = CompletableFuture<LanRouteResult?>()
        val remaining = AtomicInteger(routes.size)
        routes.forEach { route ->
            thread(name = "termbridge-lan-route", isDaemon = true) {
                val result = probe(route)
                results += result
                if (result.connected) winner.complete(result)
                if (remaining.decrementAndGet() == 0) winner.complete(null)
            }
        }
        val first = runCatching { winner.get(PROBE_TIMEOUT_MS + 2_000L, TimeUnit.MILLISECONDS) }.getOrNull()
        return first to synchronized(results) { results.toList() }
    }

    fun describe(context: Context, result: LanRouteResult): String = when {
        result.connected -> context.getString(R.string.lan_route_ok, result.route.label, result.millis,
            result.reply ?: "?", result.localAddress ?: "?")
        result.accepted -> context.getString(R.string.lan_route_no_reply, result.route.label, result.millis,
            result.error ?: "?", result.localAddress ?: "?")
        else -> context.getString(R.string.lan_route_failed, result.route.label, result.millis, result.error ?: "?")
    }
}

/**
 * OkHttp asks for a direct connection's socket on its own thread. While a VPN owns the
 * default route, hand it a socket on whichever route reached the LAN host first.
 */
class DirectRouteSocketFactory(
    private val context: Context,
    private val host: String,
    private val port: Int,
    private val secure: Boolean,
    private val path: String,
) : SocketFactory() {
    override fun createSocket(): Socket {
        val routes = LanRoutes.candidates(context)
        if (routes.size == 1) return SocketFactory.getDefault().createSocket()
        val (winner, results) = LanRoutes.race(routes) { LanRoutes.probe(it, host, port, secure, path) }
        if (winner == null) {
            throw ConnectException(context.getString(R.string.lan_route_all_failed, "$host:$port",
                results.joinToString("; ") { LanRoutes.describe(context, it) }))
        }
        return (winner.route.network?.socketFactory ?: SocketFactory.getDefault()).createSocket()
    }

    override fun createSocket(host: String, port: Int): Socket =
        createSocket().apply { connect(InetSocketAddress(host, port)) }

    override fun createSocket(host: String, port: Int, localHost: InetAddress, localPort: Int): Socket =
        createSocket().apply { bind(InetSocketAddress(localHost, localPort)); connect(InetSocketAddress(host, port)) }

    override fun createSocket(host: InetAddress, port: Int): Socket =
        createSocket().apply { connect(InetSocketAddress(host, port)) }

    override fun createSocket(address: InetAddress, port: Int, localAddress: InetAddress, localPort: Int): Socket =
        createSocket().apply { bind(InetSocketAddress(localAddress, localPort)); connect(InetSocketAddress(address, port)) }
}
