package com.termbridge.android.browser

import com.termbridge.android.protocol.ProxyTunnelProtocol
import okio.ByteString.Companion.decodeBase64
import okio.ByteString.Companion.toByteString
import java.io.ByteArrayOutputStream
import java.io.Closeable
import java.io.InputStream
import java.io.OutputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.URI
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

interface ProxyTunnelTransport {
    fun sendTunnelOpen(id: String, host: String, port: Int): Boolean
    fun sendTunnelData(id: String, base64Data: String): Boolean
    fun sendTunnelAck(id: String, bytes: Int): Boolean
    fun sendTunnelClose(id: String, reason: String? = null): Boolean
}

/**
 * Local loopback HTTP / HTTP CONNECT / SOCKS5 proxy server that multiplexes every
 * TCP connection from the built-in browser WebView through TermBridge `proxy_tunnel` frames.
 */
class LocalProxyServer(
    private val transport: ProxyTunnelTransport,
) : Closeable {

    private class ActiveTunnel(
        val id: String,
        val socket: Socket,
        val output: OutputStream,
    ) {
        val openedLatch = CountDownLatch(1)
        @Volatile var opened = false
        @Volatile var closeReason: String? = null
        val closed = AtomicBoolean(false)
        val unackedBytes = AtomicInteger(0)
        val writeLock = Any()
    }

    private val server = ServerSocket(0, 64, InetAddress.getByName("127.0.0.1"))
    val port: Int get() = server.localPort

    private val closed = AtomicBoolean(false)
    private val tunnels = ConcurrentHashMap<String, ActiveTunnel>()
    private val acceptExecutor = Executors.newSingleThreadExecutor { r ->
        Thread(r, "tb-proxy-accept").apply { isDaemon = true }
    }
    private val workerExecutor = Executors.newCachedThreadPool { r ->
        Thread(r, "tb-proxy-worker").apply { isDaemon = true }
    }

    init {
        acceptExecutor.execute { acceptLoop() }
    }

    fun onTunnelOpened(id: String) {
        val tunnel = tunnels[id] ?: return
        tunnel.opened = true
        tunnel.openedLatch.countDown()
    }

    fun onTunnelData(id: String, base64Data: String) {
        val tunnel = tunnels[id] ?: return
        if (tunnel.closed.get()) return
        val bytes = base64Data.decodeBase64()?.toByteArray() ?: return
        if (bytes.isEmpty()) return
        try {
            synchronized(tunnel.writeLock) {
                tunnel.output.write(bytes)
                tunnel.output.flush()
            }
            val pending = tunnel.unackedBytes.addAndGet(bytes.size)
            if (pending >= ProxyTunnelProtocol.ACK_BATCH_BYTES) {
                val ack = tunnel.unackedBytes.getAndSet(0)
                if (ack > 0) transport.sendTunnelAck(id, ack)
            }
        } catch (_: Throwable) {
            closeTunnel(tunnel, notifyRemote = true, reason = "Local browser closed")
        }
    }

    fun onTunnelClosed(id: String, reason: String?) {
        val tunnel = tunnels[id] ?: return
        tunnel.closeReason = reason
        tunnel.openedLatch.countDown()
        closeTunnel(tunnel, notifyRemote = false, reason = reason)
    }

    fun resetAllTunnels(reason: String) {
        for (tunnel in tunnels.values.toList()) {
            tunnel.closeReason = reason
            tunnel.openedLatch.countDown()
            closeTunnel(tunnel, notifyRemote = false, reason = reason)
        }
    }

    override fun close() {
        if (!closed.compareAndSet(false, true)) return
        runCatching { server.close() }
        for (tunnel in tunnels.values.toList()) {
            closeTunnel(tunnel, notifyRemote = true, reason = "Browser closed")
        }
        tunnels.clear()
        acceptExecutor.shutdownNow()
        workerExecutor.shutdownNow()
    }

    private fun acceptLoop() {
        while (!closed.get() && !server.isClosed) {
            val client = runCatching { server.accept() }.getOrNull() ?: break
            if (closed.get()) {
                runCatching { client.close() }
                break
            }
            workerExecutor.execute { handleClient(client) }
        }
    }

    private fun handleClient(socket: Socket) {
        try {
            socket.tcpNoDelay = true
            socket.soTimeout = HANDSHAKE_TIMEOUT_MS
            val input = socket.getInputStream()
            val output = socket.getOutputStream()
            val first = input.read()
            if (first < 0) {
                runCatching { socket.close() }
                return
            }
            if (first == 0x05) {
                handleSocks5(socket, input, output)
            } else {
                handleHttpProxy(socket, first, input, output)
            }
        } catch (_: Throwable) {
            runCatching { socket.close() }
        }
    }

    private fun handleSocks5(socket: Socket, input: InputStream, output: OutputStream) {
        val nMethods = input.read()
        if (nMethods <= 0) {
            socket.close(); return
        }
        val methods = readExact(input, nMethods) ?: run { socket.close(); return }
        if (!methods.contains(0x00.toByte())) {
            output.write(byteArrayOf(0x05, 0xFF.toByte()))
            output.flush()
            socket.close(); return
        }
        output.write(byteArrayOf(0x05, 0x00))
        output.flush()

        val header = readExact(input, 4) ?: run { socket.close(); return }
        if (header[0].toInt() != 0x05 || header[1].toInt() != 0x01) {
            output.write(byteArrayOf(0x05, 0x07, 0x00, 0x01, 0, 0, 0, 0, 0, 0))
            output.flush()
            socket.close(); return
        }
        val host = when (header[3].toInt() and 0xFF) {
            0x01 -> {
                val addr = readExact(input, 4) ?: run { socket.close(); return }
                InetAddress.getByAddress(addr).hostAddress ?: ""
            }
            0x03 -> {
                val len = input.read()
                if (len <= 0) { socket.close(); return }
                val bytes = readExact(input, len) ?: run { socket.close(); return }
                String(bytes, Charsets.US_ASCII)
            }
            0x04 -> {
                val addr = readExact(input, 16) ?: run { socket.close(); return }
                InetAddress.getByAddress(addr).hostAddress ?: ""
            }
            else -> {
                output.write(byteArrayOf(0x05, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0))
                output.flush()
                socket.close(); return
            }
        }
        val portBytes = readExact(input, 2) ?: run { socket.close(); return }
        val targetPort = ((portBytes[0].toInt() and 0xFF) shl 8) or (portBytes[1].toInt() and 0xFF)
        if (host.isEmpty() || targetPort !in 1..65535) {
            output.write(byteArrayOf(0x05, 0x04, 0x00, 0x01, 0, 0, 0, 0, 0, 0))
            output.flush()
            socket.close(); return
        }

        val tunnel = openRemoteTunnel(socket, output, host, targetPort)
        if (tunnel == null) {
            output.write(byteArrayOf(0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0))
            output.flush()
            socket.close(); return
        }
        output.write(byteArrayOf(0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0))
        output.flush()
        socket.soTimeout = 0
        pumpClientToRemote(tunnel, input)
    }

    private fun handleHttpProxy(socket: Socket, firstByte: Int, input: InputStream, output: OutputStream) {
        val headerResult = readHttpHeader(firstByte, input) ?: run {
            socket.close(); return
        }
        val headerText = String(headerResult.headerBytes, Charsets.ISO_8859_1)
        val lines = headerText.split("\r\n")
        val requestLine = lines.firstOrNull().orEmpty()
        val parts = requestLine.split(' ')
        if (parts.size < 3) {
            writeHttpError(output, 400, "Bad Request", "Malformed HTTP proxy request")
            socket.close(); return
        }
        val method = parts[0].uppercase()
        val rawTarget = parts[1]
        val version = parts[2]

        if (method == "CONNECT") {
            val (host, targetPort) = parseHostPort(rawTarget, 443) ?: run {
                writeHttpError(output, 400, "Bad Request", "Invalid CONNECT authority")
                socket.close(); return
            }
            val tunnel = openRemoteTunnel(socket, output, host, targetPort) ?: run {
                writeHttpError(output, 502, "Bad Gateway", "TermBridge Host could not reach $host:$targetPort")
                socket.close(); return
            }
            output.write("HTTP/1.1 200 Connection Established\r\n\r\n".toByteArray(Charsets.US_ASCII))
            output.flush()
            if (headerResult.trailingBytes.isNotEmpty()) {
                sendUpstreamChunked(tunnel, headerResult.trailingBytes, 0, headerResult.trailingBytes.size)
            }
            socket.soTimeout = 0
            pumpClientToRemote(tunnel, input)
            return
        }

        // Plain HTTP proxy request: e.g. GET http://127.0.0.1:8765/path?q=1 HTTP/1.1
        val headers = lines.drop(1).filter { it.isNotEmpty() }
        val hostHeader = headers.firstOrNull { it.startsWith("Host:", ignoreCase = true) }
            ?.substringAfter(':')?.trim()
        val (host, targetPort, originTarget) = parseHttpForwardTarget(rawTarget, hostHeader) ?: run {
            writeHttpError(output, 400, "Bad Request", "Invalid HTTP proxy target")
            socket.close(); return
        }
        val hasUpgrade = headers.any { it.startsWith("Upgrade:", ignoreCase = true) }
        val rewritten = StringBuilder(headerText.length + 32)
        rewritten.append(method).append(' ').append(originTarget).append(' ').append(version).append("\r\n")
        var sawHost = false
        for (line in headers) {
            val lower = line.lowercase()
            if (lower.startsWith("proxy-connection:") || lower.startsWith("proxy-authorization:")) continue
            if (!hasUpgrade && lower.startsWith("connection:")) continue
            if (lower.startsWith("host:")) sawHost = true
            rewritten.append(line).append("\r\n")
        }
        if (!sawHost) {
            val authority = if (targetPort == 80) formatHost(host) else "${formatHost(host)}:$targetPort"
            rewritten.append("Host: ").append(authority).append("\r\n")
        }
        if (!hasUpgrade) {
            rewritten.append("Connection: close\r\n")
        }
        rewritten.append("\r\n")

        val tunnel = openRemoteTunnel(socket, output, host, targetPort) ?: run {
            writeHttpError(output, 502, "Bad Gateway", "TermBridge Host could not reach $host:$targetPort")
            socket.close(); return
        }
        val headBytes = rewritten.toString().toByteArray(Charsets.ISO_8859_1)
        if (!sendUpstreamChunked(tunnel, headBytes, 0, headBytes.size)) {
            closeTunnel(tunnel, notifyRemote = true, reason = "Failed to send HTTP request")
            return
        }
        if (headerResult.trailingBytes.isNotEmpty()) {
            sendUpstreamChunked(tunnel, headerResult.trailingBytes, 0, headerResult.trailingBytes.size)
        }
        socket.soTimeout = 0
        pumpClientToRemote(tunnel, input)
    }

    private fun openRemoteTunnel(socket: Socket, output: OutputStream, host: String, port: Int): ActiveTunnel? {
        val id = UUID.randomUUID().toString().replace("-", "").take(16)
        val tunnel = ActiveTunnel(id, socket, output)
        tunnels[id] = tunnel
        if (!transport.sendTunnelOpen(id, host, port)) {
            tunnels.remove(id)
            return null
        }
        val signaled = runCatching { tunnel.openedLatch.await(CONNECT_TIMEOUT_MS, TimeUnit.MILLISECONDS) }.getOrDefault(false)
        if (!signaled || !tunnel.opened || tunnel.closed.get()) {
            closeTunnel(tunnel, notifyRemote = true, reason = "Connect timed out or refused")
            return null
        }
        return tunnel
    }

    private fun pumpClientToRemote(tunnel: ActiveTunnel, input: InputStream) {
        val buffer = ByteArray(ProxyTunnelProtocol.MAX_CHUNK_BYTES)
        try {
            while (!tunnel.closed.get() && !closed.get()) {
                val read = input.read(buffer)
                if (read <= 0) break
                if (!sendUpstreamChunked(tunnel, buffer, 0, read)) break
            }
        } catch (_: Throwable) {
            // Socket closed locally or remotely.
        } finally {
            closeTunnel(tunnel, notifyRemote = true, reason = null)
        }
    }

    private fun sendUpstreamChunked(tunnel: ActiveTunnel, data: ByteArray, offset: Int, length: Int): Boolean {
        var cursor = offset
        val end = offset + length
        while (cursor < end) {
            val size = (end - cursor).coerceAtMost(ProxyTunnelProtocol.MAX_CHUNK_BYTES)
            val b64 = data.toByteString(cursor, size).base64()
            if (!transport.sendTunnelData(tunnel.id, b64)) return false
            cursor += size
        }
        return true
    }

    private fun closeTunnel(tunnel: ActiveTunnel, notifyRemote: Boolean, reason: String?) {
        if (!tunnel.closed.compareAndSet(false, true)) return
        tunnels.remove(tunnel.id)
        val remainingAck = tunnel.unackedBytes.getAndSet(0)
        if (remainingAck > 0 && notifyRemote) {
            runCatching { transport.sendTunnelAck(tunnel.id, remainingAck) }
        }
        if (notifyRemote) {
            runCatching { transport.sendTunnelClose(tunnel.id, reason) }
        }
        runCatching { tunnel.socket.close() }
    }

    private data class HttpHeaderRead(val headerBytes: ByteArray, val trailingBytes: ByteArray)

    private fun readHttpHeader(firstByte: Int, input: InputStream): HttpHeaderRead? {
        val out = ByteArrayOutputStream(1024)
        out.write(firstByte)
        val buf = ByteArray(2048)
        while (out.size() < MAX_HEADER_BYTES) {
            val existing = out.toByteArray()
            val marker = findHeaderEnd(existing)
            if (marker >= 0) {
                val head = existing.copyOfRange(0, marker)
                val tail = existing.copyOfRange(marker + 4, existing.size)
                return HttpHeaderRead(head, tail)
            }
            val n = input.read(buf)
            if (n <= 0) return null
            out.write(buf, 0, n)
        }
        return null
    }

    private fun findHeaderEnd(bytes: ByteArray): Int {
        for (i in 0..bytes.size - 4) {
            if (bytes[i] == 13.toByte() && bytes[i + 1] == 10.toByte() &&
                bytes[i + 2] == 13.toByte() && bytes[i + 3] == 10.toByte()
            ) return i
        }
        return -1
    }

    private fun readExact(input: InputStream, count: Int): ByteArray? {
        val buf = ByteArray(count)
        var offset = 0
        while (offset < count) {
            val n = input.read(buf, offset, count - offset)
            if (n <= 0) return null
            offset += n
        }
        return buf
    }

    private fun writeHttpError(output: OutputStream, status: Int, title: String, detail: String) {
        val body = "$detail\n".toByteArray(Charsets.UTF_8)
        val response = "HTTP/1.1 $status $title\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${body.size}\r\nConnection: close\r\n\r\n"
        runCatching {
            output.write(response.toByteArray(Charsets.US_ASCII))
            output.write(body)
            output.flush()
        }
    }

    private data class HttpForwardTarget(val host: String, val port: Int, val originTarget: String)

    private fun parseHttpForwardTarget(rawTarget: String, hostHeader: String?): HttpForwardTarget? {
        if (rawTarget.startsWith("http://", ignoreCase = true) || rawTarget.startsWith("https://", ignoreCase = true)) {
            val uri = runCatching { URI(rawTarget) }.getOrNull() ?: return null
            val host = uri.host?.takeIf { it.isNotBlank() } ?: return null
            val defaultPort = if (uri.scheme.equals("https", ignoreCase = true)) 443 else 80
            val port = if (uri.port in 1..65535) uri.port else defaultPort
            val path = uri.rawPath.orEmpty().ifEmpty { "/" }
            val origin = if (uri.rawQuery != null) "$path?${uri.rawQuery}" else path
            return HttpForwardTarget(host.removePrefix("[").removeSuffix("]"), port, origin)
        }
        val authority = hostHeader?.takeIf { it.isNotBlank() } ?: return null
        val (host, port) = parseHostPort(authority, 80) ?: return null
        val origin = if (rawTarget.startsWith("/")) rawTarget else "/$rawTarget"
        return HttpForwardTarget(host, port, origin)
    }

    private fun parseHostPort(authority: String, defaultPort: Int): Pair<String, Int>? {
        val trimmed = authority.trim()
        if (trimmed.isEmpty()) return null
        if (trimmed.startsWith("[")) {
            val close = trimmed.indexOf(']')
            if (close <= 1) return null
            val host = trimmed.substring(1, close)
            val rest = trimmed.substring(close + 1)
            val port = if (rest.startsWith(":")) rest.substring(1).toIntOrNull() ?: return null else defaultPort
            return if (port in 1..65535) host to port else null
        }
        val colon = trimmed.lastIndexOf(':')
        if (colon > 0 && trimmed.indexOf(':') == colon) {
            val host = trimmed.substring(0, colon)
            val port = trimmed.substring(colon + 1).toIntOrNull() ?: return null
            return if (host.isNotBlank() && port in 1..65535) host to port else null
        }
        return trimmed to defaultPort
    }

    private fun formatHost(host: String): String = if (host.contains(':') && !host.startsWith('[')) "[$host]" else host

    private companion object {
        const val HANDSHAKE_TIMEOUT_MS = 15_000
        const val CONNECT_TIMEOUT_MS = 15_000L
        const val MAX_HEADER_BYTES = 64 * 1024
    }
}
