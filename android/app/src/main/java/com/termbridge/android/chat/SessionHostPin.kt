package com.termbridge.android.chat

import com.termbridge.android.data.ConnectionSettings

/**
 * The identity a session window keeps for its whole life.
 *
 * `hostId` is empty until a profile has negotiated its Host, so the endpoint
 * (relay plus credential fingerprint) is carried as well. Discovery only fills
 * in the Host, leaving the endpoint unchanged, so a window opened before the
 * Host was known still recognises its own profile afterwards.
 */
data class SessionPin(val hostId: String, val endpointKey: String) {
    val isEmpty get() = hostId.isEmpty() && endpointKey.isEmpty()
}

/**
 * Where a session window may connect, and whether the app's current profile has
 * to move there. A null profile means "stop": there is nothing safe to use.
 */
data class SessionNavigation(val profile: ConnectionSettings?, val selectProfileKey: String?)

/**
 * A session window belongs to the Host it was opened against. Changing the
 * app's current profile, or switching between the terminal and chat views, must
 * not move a session ID onto another machine, where the same Herdr pane ID can
 * exist and would be attached silently.
 */
object SessionHostPin {
    /** The identity a freshly opened window pins to, if any is knowable. */
    fun pin(
        requestedHost: String?,
        current: ConnectionSettings?,
        profiles: List<ConnectionSettings> = emptyList(),
    ): SessionPin? {
        val host = requestedHost?.trim().orEmpty()
        val origin = if (host.isEmpty()) {
            current
        } else {
            current?.takeIf { it.hostId.trim() == host } ?: profiles.filter { it.hostId.trim() == host }.singleOrNull()
        }
        val pinned = SessionPin(
            hostId = host.ifEmpty { origin?.hostId?.trim().orEmpty() },
            endpointKey = origin?.endpointKey.orEmpty(),
        )
        return pinned.takeUnless { it.isEmpty }
    }

    /** Rebuilt from saved instance state, so a rotation cannot re-pin to whatever is current now. */
    fun restore(hostId: String?, endpointKey: String?): SessionPin? =
        SessionPin(hostId.orEmpty(), endpointKey.orEmpty()).takeUnless { it.isEmpty }

    /**
     * Resolves the pin against saved profiles. Returns null when the pinned
     * profile is gone: reconnecting through whichever profile happens to be
     * current would attach this session ID somewhere else.
     */
    fun resolve(
        pin: SessionPin?,
        current: ConnectionSettings?,
        profiles: List<ConnectionSettings>,
    ): ConnectionSettings? {
        if (pin == null) return current
        val host = pin.hostId.trim()
        val candidates = (profiles + listOfNotNull(current)).distinctBy { it.profileKey }
        if (pin.endpointKey.isNotEmpty()) {
            return candidates.firstOrNull { it.endpointKey == pin.endpointKey && (host.isEmpty() || it.hostId.trim() == host) }
        }
        if (host.isEmpty()) return null
        return current?.takeIf { it.hostId.trim() == host }
            ?: candidates.filter { it.hostId.trim() == host }.singleOrNull()
    }

    /**
     * Session and notification navigation may only select a profile the user has
     * saved. It never synthesizes one out of the unrelated current
     * configuration: that would hand this session another Host's relay and
     * credentials under the wanted Host's name. Roster discovery and pairing
     * remain the only paths that create profiles.
     */
    fun navigate(
        pin: SessionPin?,
        current: ConnectionSettings?,
        profiles: List<ConnectionSettings>,
    ): SessionNavigation {
        val target = resolve(pin, current, profiles) ?: return SessionNavigation(null, null)
        val select = target.profileKey.takeIf { it != current?.profileKey }
        return SessionNavigation(target, select)
    }

    /** Once the pinned profile has negotiated a Host, keep that stronger identity. */
    fun negotiated(pin: SessionPin?, settings: ConnectionSettings): SessionPin? {
        if (pin == null) return null
        val host = settings.hostId.trim()
        if (host.isEmpty() || pin.hostId == host) return pin
        return pin.copy(hostId = host)
    }
}
