package com.termbridge.android.browser

import okio.ByteString.Companion.decodeBase64
import okio.ByteString.Companion.toByteString
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors

class LocalProxyServerTest {
    @Test
    fun policyInterceptsLoopbackAndPrivateUrls() {
        assertTrue(RemoteBrowserPolicy.shouldIntercept("http://127.0.0.1:8765"))
        assertTrue(RemoteBrowserPolicy.shouldIntercept("http://localhost:3000/app"))
        assertTrue(RemoteBrowserPolicy.shouldIntercept("http://0.0.0.0:5173"))
        assertTrue(RemoteBrowserPolicy.shouldIntercept("http://[::1]:8080/"))
        assertTrue(RemoteBrowserPolicy.shouldIntercept("http://192.168.0.177/stream"))
        assertTrue(RemoteBrowserPolicy.shouldIntercept("http://100.64.1.2:8000"))
        assertTrue(RemoteBrowserPolicy.shouldIntercept("http://mac-mini.local:8765"))
        assertFalse(RemoteBrowserPolicy.shouldIntercept("https://github.com/yunfengsay/termbridge"))
        assertEquals("http://127.0.0.1:8765/live", RemoteBrowserPolicy.normalizeEntryUrl("http://0.0.0.0:8765/live"))
        assertEquals("http://127.0.0.1:8765", RemoteBrowserPolicy.normalizeEntryUrl("127.0.0.1:8765"))
    }

    @Test
    fun proxiesPlainHttpAndConnectThroughTransport() {
        val upstream = ServerSocket(0, 8, InetAddress.getByName("127.0.0.1"))
        val pool = Executors.newCachedThreadPool()
        pool.execute {
            while (!upstream.isClosed) {
                val s = runCatching { upstream.accept() }.getOrNull() ?: break
                pool.execute {
                    s.use { sock ->
                        val buf = ByteArray(4096)
                        val n = sock.getInputStream().read(buf)
                        val req = if (n > 0) String(buf, 0, n) else ""
                        val body = if (req.startsWith("GET /hello HTTP/1.1")) "world" else "tunnel:$req"
                        val resp = "HTTP/1.1 200 OK\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n$body"
                        sock.getOutputStream().write(resp.toByteArray())
                        sock.getOutputStream().flush()
                    }
                }
            }
        }

        val remoteSockets = ConcurrentHashMap<String, Socket>()
        lateinit var proxy: LocalProxyServer
        val transport = object : ProxyTunnelTransport {
            override fun sendTunnelOpen(id: String, host: String, port: Int): Boolean {
                pool.execute {
                    try {
                        val s = Socket(host, port)
                        remoteSockets[id] = s
                        proxy.onTunnelOpened(id)
                        val buf = ByteArray(16 * 1024)
                        val input = s.getInputStream()
                        while (true) {
                            val n = input.read(buf)
                            if (n <= 0) break
                            proxy.onTunnelData(id, buf.toByteString(0, n).base64())
                        }
                        proxy.onTunnelClosed(id, null)
                    } catch (e: Throwable) {
                        proxy.onTunnelClosed(id, e.message)
                    } finally {
                        remoteSockets.remove(id)?.let { runCatching { it.close() } }
                    }
                }
                return true
            }

            override fun sendTunnelData(id: String, base64Data: String): Boolean {
                val bytes = base64Data.decodeBase64()?.toByteArray() ?: return false
                val s = remoteSockets[id] ?: return false
                return runCatching { s.getOutputStream().write(bytes); s.getOutputStream().flush(); true }.getOrDefault(false)
            }

            override fun sendTunnelAck(id: String, bytes: Int): Boolean = true

            override fun sendTunnelClose(id: String, reason: String?): Boolean {
                remoteSockets.remove(id)?.let { runCatching { it.close() } }
                return true
            }
        }
        proxy = LocalProxyServer(transport)

        try {
            // 1. Plain HTTP proxy request
            Socket("127.0.0.1", proxy.port).use { client ->
                client.soTimeout = 5000
                client.getOutputStream().write(
                    "GET http://127.0.0.1:${upstream.localPort}/hello HTTP/1.1\r\nHost: 127.0.0.1:${upstream.localPort}\r\nProxy-Connection: keep-alive\r\n\r\n".toByteArray(),
                )
                client.getOutputStream().flush()
                val reply = client.getInputStream().readBytes().toString(Charsets.UTF_8)
                assertTrue(reply.contains("HTTP/1.1 200 OK"))
                assertTrue(reply.endsWith("\r\n\r\nworld"))
            }

            // 2. HTTP CONNECT tunnel
            Socket("127.0.0.1", proxy.port).use { client ->
                client.soTimeout = 5000
                val out = client.getOutputStream()
                val input = client.getInputStream()
                out.write("CONNECT 127.0.0.1:${upstream.localPort} HTTP/1.1\r\nHost: 127.0.0.1:${upstream.localPort}\r\n\r\n".toByteArray())
                out.flush()
                val statusBuf = ByteArray(128)
                val statusLen = input.read(statusBuf)
                assertTrue(String(statusBuf, 0, statusLen).startsWith("HTTP/1.1 200"))
                out.write("GET /hello HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n".toByteArray())
                out.flush()
                val body = input.readBytes().toString(Charsets.UTF_8)
                assertTrue(body.endsWith("\r\n\r\nworld"))
            }
        } finally {
            proxy.close()
            upstream.close()
            pool.shutdownNow()
        }
    }
}
