package com.termbridge.android.chat

import com.termbridge.android.data.ConnectionSettings

/**
 * The only place a session screen may obtain a connection.
 *
 * It hands back the profile this window was pinned to, or refuses outright, so
 * no screen can quietly fall back to whichever Host is current — a fallback
 * would send this window's session ID to a different machine, where the same
 * Herdr pane ID can exist. Each attempt is stamped, so a client that has already
 * been replaced cannot deliver late callbacks into the new one's state.
 *
 * The client factory is injected so the refusal is testable: when the pinned
 * profile is gone, nothing is constructed at all.
 */
class SessionConnectionGate<T : Any>(
    private val openClient: (ConnectionSettings) -> T,
    private val closeClient: (T) -> Unit = {},
) {
    var pin: SessionPin? = null
    var client: T? = null
        private set
    var settings: ConnectionSettings? = null
        private set

    /** Bumped whenever a client is dropped, so its pending callbacks are stale. */
    var generation = 0
        private set

    /** @return the new client, or null when the pinned profile is no longer saved. */
    fun connect(current: ConnectionSettings?, profiles: List<ConnectionSettings>): T? {
        disconnect()
        val resolved = SessionHostPin.resolve(pin, current, profiles) ?: return null
        pin = SessionHostPin.negotiated(pin, resolved)
        settings = resolved
        return openClient(resolved).also { client = it }
    }

    fun disconnect() {
        generation++
        client?.let(closeClient)
        client = null
    }

    /** A callback belongs to the live client only while nothing has replaced it. */
    fun accepts(generation: Int) = client != null && generation == this.generation
}

/**
 * Carries a window's pin from one screen to the next.
 *
 * A view switch, a notification trampoline or a fresh Activity all hand the pin
 * across as Intent extras. The receiving screen must adopt it verbatim:
 * recomputing the pin there would re-derive it from whatever profile is current
 * by then, which is exactly how a session ID ends up on another Host.
 */
object SessionPinHandoff {
    /** Extras for a forwarded pin. Null means "no pin to forward". */
    fun extras(pin: SessionPin?): Pair<String?, String?> =
        if (pin == null) null to null else pin.hostId to pin.endpointKey

    /**
     * @param forwarded whether the Intent carried a pin at all
     *
     * A forwarded pin is kept even when it is unusable: resolving an empty pin
     * fails closed, whereas dropping it would let this screen adopt the current
     * Host instead.
     */
    fun receive(
        forwarded: Boolean,
        hostId: String?,
        endpointKey: String?,
        current: ConnectionSettings?,
        profiles: List<ConnectionSettings>,
    ): SessionPin? =
        if (forwarded) {
            SessionPin(hostId.orEmpty().trim(), endpointKey.orEmpty().trim())
        } else {
            SessionHostPin.pin(hostId, current, profiles)
        }
}
