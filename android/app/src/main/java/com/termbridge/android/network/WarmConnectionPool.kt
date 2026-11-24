package com.termbridge.android.network

import android.content.Context
import android.os.Handler
import android.os.Looper
import com.termbridge.android.data.ConnectionSettings
import com.termbridge.android.protocol.ControlMessage

/**
 * Keeps 1 pre-authenticated standby TermbridgeClient ready for the active Host so opening a
 * Terminal or Agent Chat skips TCP + TLS + HMAC + hello handshake completely (0ms connect).
 *
 * Once claimed, the caller exclusively owns that socket (preserving attach / upload ownership).
 */
object WarmConnectionPool {
    private const val IDLE_TTL_MS = 90_000L

    private class Standby(
        val key: String,
        val client: TermbridgeClient,
        var ready: Boolean = false,
        var failed: Boolean = false,
        val createdAtMs: Long = System.currentTimeMillis(),
    )

    private val handler = Handler(Looper.getMainLooper())
    private var standby: Standby? = null
    private val expireTask = Runnable { invalidate() }

    private fun settingsKey(settings: ConnectionSettings): String =
        "${settings.relayUrl.trim()}\u0000${settings.hostId.trim()}\u0000${settings.endpointKey}\u0000${settings.networkPolicy.wireName}\u0000${settings.connectionMode?.value.orEmpty()}"

    @Synchronized
    fun prewarm(context: Context, settings: ConnectionSettings) {
        if (!settings.connectionEnabled || settings.validationError() != null || settings.hostId.isBlank()) {
            invalidate()
            return
        }
        val key = settingsKey(settings)
        val existing = standby
        if (existing != null && existing.key == key && !existing.failed &&
            System.currentTimeMillis() - existing.createdAtMs < IDLE_TTL_MS
        ) {
            return
        }
        invalidate()
        lateinit var slot: Standby
        val listener = object : TermbridgeClient.Listener {
            override fun onConnectionState(state: ConnectionState) {
                if (state is ConnectionState.Failed || state is ConnectionState.Disconnected) {
                    synchronized(WarmConnectionPool) {
                        if (standby === slot) {
                            slot.failed = true
                            standby = null
                        }
                    }
                }
            }
            override fun onReady(client: TermbridgeClient) {
                synchronized(WarmConnectionPool) {
                    if (standby === slot) slot.ready = true
                }
            }
            override fun onControl(message: ControlMessage) = Unit
            override fun onPtyOutput(sid: Int, data: ByteArray) = Unit
        }
        val client = TermbridgeClient(settings, listener, backgroundMonitor = false, context = context.applicationContext)
        slot = Standby(key = key, client = client)
        standby = slot
        handler.removeCallbacks(expireTask)
        handler.postDelayed(expireTask, IDLE_TTL_MS)
        client.connect()
    }

    /**
     * Claims a pre-authenticated client if one is ready for `settings` and transfers its listener.
     * Returns null if no ready standby socket matches, letting the caller connect normally.
     */
    @Synchronized
    fun claimReady(settings: ConnectionSettings, listener: TermbridgeClient.Listener): TermbridgeClient? {
        val slot = standby ?: return null
        if (slot.failed || !slot.ready || slot.key != settingsKey(settings)) return null
        if (System.currentTimeMillis() - slot.createdAtMs >= IDLE_TTL_MS) {
            invalidate()
            return null
        }
        standby = null
        handler.removeCallbacks(expireTask)
        if (!slot.client.transferListener(listener)) {
            slot.client.disconnect()
            return null
        }
        return slot.client
    }

    @Synchronized
    fun invalidate() {
        handler.removeCallbacks(expireTask)
        val old = standby
        standby = null
        old?.client?.disconnect()
    }
}
