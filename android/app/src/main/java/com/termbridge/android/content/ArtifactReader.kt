package com.termbridge.android.content

import com.termbridge.android.data.ConnectionSettings
import com.termbridge.android.network.ConnectionState
import com.termbridge.android.network.TermbridgeClient
import com.termbridge.android.protocol.ControlMessage
import com.termbridge.android.protocol.SessionFileProtocol
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.ByteArrayOutputStream
import java.util.UUID
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit

/** Read on a worker thread. No shell, ambient browser cookies, or credential forwarding. */
class ArtifactReader(settings: ConnectionSettings, private val sessionId: String, context: android.content.Context) : AutoCloseable, TermbridgeClient.Listener {
    private val ready = CompletableFuture<Unit>()
    private val pending = ConcurrentHashMap<String, CompletableFuture<ControlMessage>>()
    private val socket = TermbridgeClient(settings, this, context = context.applicationContext)
    private val http = OkHttpClient.Builder().followRedirects(false).followSslRedirects(false)
        .callTimeout(20, TimeUnit.SECONDS).build()
    @Volatile private var closed = false
    private var started = false

    fun read(target: ArtifactTarget): ByteArray {
        check(!closed) { "Preview closed" }
        if (target.remote) {
            require(target.location.startsWith("https://")) { "Only HTTPS content can be previewed" }
            return http.newCall(Request.Builder().url(target.location).build()).execute().use { response ->
                check(response.isSuccessful) { "Preview HTTP ${response.code}; redirects are not followed" }
                val body = response.body
                require(body.contentLength() <= SessionFileProtocol.MAX_FILE_BYTES) { "File exceeds 20 MiB" }
                body.byteStream().use { stream ->
                    val out = ByteArrayOutputStream()
                    val chunk = ByteArray(16 * 1024)
                    while (true) {
                        check(!closed)
                        val count = stream.read(chunk)
                        if (count < 0) break
                        require(out.size() + count <= SessionFileProtocol.MAX_FILE_BYTES) { "File exceeds 20 MiB" }
                        out.write(chunk, 0, count)
                    }
                    out.toByteArray()
                }
            }
        }
        synchronized(this) { check(!closed); if (!started) { started = true; socket.connect() } }
        ready.get(15, TimeUnit.SECONDS)
        val out = ByteArrayOutputStream()
        var version: String? = null
        var expectedSize: Long? = null
        do {
            check(!closed)
            val id = UUID.randomUUID().toString()
            val future = CompletableFuture<ControlMessage>()
            pending[id] = future
            val message = try {
                val fields = mutableListOf<Pair<String, Any>>("t" to SessionFileProtocol.READ, "requestId" to id,
                    "sessionId" to sessionId, "path" to target.location, "offset" to out.size())
                version?.let { fields.add("version" to it) }
                check(socket.sendControl(*fields.toTypedArray()))
                future.get(20, TimeUnit.SECONDS)
            } finally { pending.remove(id) }
            message.string("error")?.let { error(it) }
            val size = (message.fields["size"] as? Number)?.toLong() ?: error("Missing file size")
            val offset = (message.fields["offset"] as? Number)?.toLong() ?: -1
            val currentVersion = message.string("version") ?: error("Missing file version")
            require(size in 0..SessionFileProtocol.MAX_FILE_BYTES.toLong() && offset == out.size().toLong())
            require(expectedSize == null || expectedSize == size)
            require(version == null || version == currentVersion) { "File changed; reopen it" }
            version = currentVersion; expectedSize = size
            val data = message.bytes("data") ?: error("Missing file data")
            require(data.size <= SessionFileProtocol.MAX_CHUNK_BYTES && out.size() + data.size <= size)
            out.write(data)
            if (message.boolean("eof") == true) { require(out.size().toLong() == size); return out.toByteArray() }
            require(data.isNotEmpty()) { "Empty file chunk" }
        } while (true)
    }

    override fun onReady(client: TermbridgeClient) { ready.complete(Unit) }
    override fun onControl(message: ControlMessage) {
        if (message.type == SessionFileProtocol.RESULT && message.string("sessionId") == sessionId) {
            message.string("requestId")?.let { pending[it]?.complete(message) }
        }
    }
    override fun onConnectionState(state: ConnectionState) {
        if (state is ConnectionState.Failed || state == ConnectionState.Disconnected) {
            val error = IllegalStateException("Host disconnected; reopen the preview")
            ready.completeExceptionally(error); pending.values.forEach { it.completeExceptionally(error) }
        }
    }
    override fun onPtyOutput(sid: Int, data: ByteArray) = Unit
    @Synchronized override fun close() {
        closed = true; ready.cancel(true); pending.values.forEach { it.cancel(true) }; pending.clear()
        socket.disconnect(); http.dispatcher.cancelAll(); http.connectionPool.evictAll()
    }
}
