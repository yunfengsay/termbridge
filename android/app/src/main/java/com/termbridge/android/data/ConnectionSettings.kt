package com.termbridge.android.data

import android.content.Context
import android.content.Intent
import androidx.core.content.edit
import com.termbridge.android.BuildConfig
import com.termbridge.android.protocol.HostNetworkPolicy
import java.net.URI
import java.security.MessageDigest
import org.json.JSONArray
import org.json.JSONObject
import com.termbridge.android.network.LanConnection

enum class ConnectionMode(val value: String) { RELAY("relay"), DIRECT("direct") }

data class ConnectionSettings(
    val relayUrl: String,
    val hostId: String,
    val secret: String,
    val tlsFingerprint: String,
    val hostName: String = "",
    val connectionEnabled: Boolean = true,
    val profileAlias: String = "",
    val networkPolicy: HostNetworkPolicy = HostNetworkPolicy.SYSTEM,
    val connectionMode: ConnectionMode? = null,
) {
    val isDirectConnection: Boolean
        get() = connectionMode?.let { it == ConnectionMode.DIRECT } ?: runCatching {
            val uri = URI(relayUrl)
            uri.scheme in setOf("ws", "wss") && LanConnection.isPrivateIPv4(uri.host.orEmpty())
        }.getOrDefault(false)
    /**
     * An explicit direct profile never uses an app proxy, whatever its address range:
     * corporate networks may assign non-RFC1918 addresses. Its VPN routes stay intact.
     */
    val bypassesAppProxy: Boolean
        get() = isDirectConnection || runCatching { LanConnection.isPrivateIPv4(URI(relayUrl).host.orEmpty()) }
            .getOrDefault(false)
    val normalizedFingerprint: String
        get() = tlsFingerprint.filter(Char::isLetterOrDigit).lowercase()

    /**
     * Identity of the relay endpoint and its credentials, independent of whether
     * a Host has been discovered yet. Host discovery only fills in `hostId`, so
     * this stays stable across it and can pin a session window that was opened
     * before the Host was known.
     */
    val endpointKey: String
        get() {
            val seed = "${relayUrl.trim()}\u0000$secret\u0000$normalizedFingerprint"
            val digest = MessageDigest.getInstance("SHA-256").digest(seed.toByteArray())
            return "pair:${digest.take(12).joinToString("") { "%02x".format(it) }}"
        }

    val profileKey: String
        get() = if (hostId.isNotBlank()) {
            val endpoint = MessageDigest.getInstance("SHA-256").digest(relayUrl.trim().toByteArray())
                .take(12).joinToString("") { "%02x".format(it) }
            "host:${hostId.trim()}@$endpoint"
        } else endpointKey

    val displayName: String
        get() = profileAlias.trim().ifBlank { hostName.trim() }.ifBlank {
            hostId.trim().ifBlank {
                runCatching { URI(relayUrl.trim()).host }.getOrNull().orEmpty().ifBlank { "Server" }
            }
        }

    fun normalized(): ConnectionSettings = copy(
        relayUrl = relayUrl.trim(),
        hostId = hostId.trim(),
        tlsFingerprint = normalizedFingerprint,
        hostName = hostName.trim(),
        profileAlias = profileAlias.trim().take(MAX_PROFILE_ALIAS_LENGTH),
    )

    fun validationError(): String? {
        val uri = runCatching { URI(relayUrl.trim()) }.getOrNull()
            ?: return "Relay URL is not valid"
        if (uri.scheme?.lowercase() !in setOf("ws", "wss") || uri.host.isNullOrBlank()) {
            return "Relay URL must start with ws:// or wss://"
        }
        if (normalizedFingerprint.isNotEmpty() && normalizedFingerprint.length != 64) {
            return "TLS fingerprint must contain 64 hexadecimal characters"
        }
        if (normalizedFingerprint.any { it !in '0'..'9' && it !in 'a'..'f' }) {
            return "TLS fingerprint is not hexadecimal"
        }
        return null
    }
}

data class ConnectionProfileState(
    val profiles: List<ConnectionSettings>,
    val activeKey: String?,
)

object ConnectionProfiles {
    fun upsert(
        state: ConnectionProfileState,
        candidate: ConnectionSettings,
        select: Boolean = true,
    ): ConnectionProfileState {
        val normalized = candidate.normalized()
        val profiles = state.profiles.toMutableList()
        val sameHost = normalized.hostId.takeIf(String::isNotBlank)?.let { hostId ->
            profiles.indexOfFirst { it.hostId == hostId && it.relayUrl.trim() == normalized.relayUrl }
        } ?: -1
        val samePair = profiles.indexOfFirst { it.profileKey == normalized.profileKey }
        val activeIndex = profiles.indexOfFirst { it.profileKey == state.activeKey }
        val active = profiles.getOrNull(activeIndex)
        val resolvesActivePair = select && normalized.hostId.isNotBlank() && active?.hostId.isNullOrBlank() &&
            active?.samePairingEndpoint(normalized) == true
        val index = when {
            sameHost >= 0 -> sameHost
            samePair >= 0 -> samePair
            resolvesActivePair -> activeIndex
            else -> -1
        }
        val previous = profiles.getOrNull(index)
        val merged = normalized.copy(
            hostName = normalized.hostName.ifBlank { previous?.hostName.orEmpty() },
            profileAlias = normalized.profileAlias.ifBlank { previous?.profileAlias.orEmpty() },
        )
        if (index >= 0) profiles[index] = merged else profiles += merged
        if (resolvesActivePair && activeIndex >= 0 && activeIndex != index) {
            profiles.removeAt(activeIndex)
        }
        return ConnectionProfileState(
            profiles = profiles.distinctBy(ConnectionSettings::profileKey),
            activeKey = if (select) normalized.profileKey else state.activeKey ?: profiles.firstOrNull()?.profileKey,
        )
    }

    fun mergeDiscoveredHosts(
        state: ConnectionProfileState,
        base: ConnectionSettings,
        hosts: List<Pair<String, String>>,
        selectedHostId: String,
    ): ConnectionProfileState {
        var next = state
        for ((hostId, name) in hosts) {
            val existingPolicy = next.profiles.firstOrNull { it.hostId == hostId && it.relayUrl == base.relayUrl }?.networkPolicy
                ?: base.networkPolicy
            next = upsert(
                next,
                base.copy(
                    hostId = hostId,
                    hostName = name,
                    profileAlias = "",
                    networkPolicy = existingPolicy,
                ),
                select = hostId == selectedHostId,
            )
        }
        return next
    }

    fun replace(state: ConnectionProfileState, previousKey: String?, candidate: ConnectionSettings): ConnectionProfileState {
        val retained = state.copy(profiles = state.profiles.filterNot { it.profileKey == previousKey })
        return upsert(retained, candidate)
    }

    fun migratedActiveKey(profiles: List<ConnectionSettings>, stored: String?): String? =
        profiles.firstOrNull { it.profileKey == stored }?.profileKey
            ?: profiles.firstOrNull { "host:${it.hostId}" == stored }?.profileKey
            ?: profiles.firstOrNull()?.profileKey

    fun select(state: ConnectionProfileState, profileKey: String): ConnectionProfileState =
        if (state.profiles.any { it.profileKey == profileKey }) state.copy(activeKey = profileKey) else state

    fun setConnectionEnabled(
        state: ConnectionProfileState,
        profileKey: String,
        enabled: Boolean,
    ): ConnectionProfileState {
        if (state.profiles.none { it.profileKey == profileKey }) return state
        return state.copy(
            profiles = state.profiles.map { profile ->
                if (profile.profileKey == profileKey) profile.copy(connectionEnabled = enabled) else profile
            },
        )
    }

    fun rename(
        state: ConnectionProfileState,
        profileKey: String,
        alias: String,
    ): ConnectionProfileState {
        if (state.profiles.none { it.profileKey == profileKey }) return state
        val normalizedAlias = alias.trim().take(MAX_PROFILE_ALIAS_LENGTH)
        return state.copy(
            profiles = state.profiles.map { profile ->
                if (profile.profileKey == profileKey) profile.copy(profileAlias = normalizedAlias) else profile
            },
        )
    }

    fun setNetworkPolicy(
        state: ConnectionProfileState,
        profileKey: String,
        policy: HostNetworkPolicy,
    ): ConnectionProfileState {
        if (state.profiles.none { it.profileKey == profileKey }) return state
        return state.copy(
            profiles = state.profiles.map { profile ->
                if (profile.profileKey == profileKey) profile.copy(networkPolicy = policy) else profile
            },
        )
    }

    fun remove(state: ConnectionProfileState, profileKey: String): ConnectionProfileState {
        val removedIndex = state.profiles.indexOfFirst { it.profileKey == profileKey }
        if (removedIndex < 0) return state
        val remaining = state.profiles.filterNot { it.profileKey == profileKey }
        val nextActive = if (state.activeKey == profileKey) {
            remaining.getOrNull(removedIndex.coerceAtMost(remaining.lastIndex))?.profileKey
                ?: remaining.lastOrNull()?.profileKey
        } else {
            state.activeKey
        }
        return ConnectionProfileState(remaining, nextActive)
    }

    private fun ConnectionSettings.samePairingEndpoint(other: ConnectionSettings): Boolean =
        relayUrl.trim() == other.relayUrl.trim() && secret == other.secret && normalizedFingerprint == other.normalizedFingerprint
}

object SettingsStore {
    private const val PREFERENCES = "connection"
    private const val RELAY_URL = "relay_url"
    private const val HOST_ID = "host_id"
    private const val SECRET = "secret"
    private const val TLS_FINGERPRINT = "tls_fingerprint"
    private const val HOST_NAME = "host_name"
    private const val PROFILES = "profiles_v2"
    private const val ACTIVE_PROFILE = "active_profile_v2"

    const val DEBUG_RELAY_URL = "tb_relay_url"
    const val DEBUG_HOST_ID = "tb_host_id"
    const val DEBUG_SECRET = "tb_secret"
    const val DEBUG_TLS_FINGERPRINT = "tb_tls_fingerprint"

    fun isConfigured(context: Context): Boolean = profiles(context).isNotEmpty()

    fun load(context: Context): ConnectionSettings {
        val state = state(context)
        state.profiles.firstOrNull { it.profileKey == state.activeKey }?.let { return it }
        state.profiles.firstOrNull()?.let { return it }
        return defaults()
    }

    fun profiles(context: Context): List<ConnectionSettings> = state(context).profiles

    fun save(context: Context, settings: ConnectionSettings) {
        store(context, ConnectionProfiles.upsert(state(context), settings))
    }

    fun replace(context: Context, previousKey: String?, settings: ConnectionSettings) {
        store(context, ConnectionProfiles.replace(state(context), previousKey, settings))
    }

    fun mergeDiscoveredHosts(
        context: Context,
        base: ConnectionSettings,
        hosts: List<Pair<String, String>>,
        selectedHostId: String,
    ) {
        store(context, ConnectionProfiles.mergeDiscoveredHosts(state(context), base, hosts, selectedHostId))
    }

    fun select(context: Context, profileKey: String): Boolean {
        val current = state(context)
        val next = ConnectionProfiles.select(current, profileKey)
        if (next.activeKey == current.activeKey) return next.profiles.any { it.profileKey == profileKey }
        store(context, next)
        return true
    }

    fun setConnectionEnabled(context: Context, profileKey: String, enabled: Boolean): ConnectionSettings? {
        val next = ConnectionProfiles.setConnectionEnabled(state(context), profileKey, enabled)
        store(context, next)
        return next.profiles.firstOrNull { it.profileKey == profileKey }
    }

    fun rename(context: Context, profileKey: String, alias: String): ConnectionSettings? {
        val next = ConnectionProfiles.rename(state(context), profileKey, alias)
        store(context, next)
        return next.profiles.firstOrNull { it.profileKey == profileKey }
    }

    fun setNetworkPolicy(
        context: Context,
        profileKey: String,
        policy: HostNetworkPolicy,
    ): ConnectionSettings? {
        val next = ConnectionProfiles.setNetworkPolicy(state(context), profileKey, policy)
        store(context, next)
        return next.profiles.firstOrNull { it.profileKey == profileKey }
    }

    fun remove(context: Context, profileKey: String): ConnectionSettings? {
        val next = ConnectionProfiles.remove(state(context), profileKey)
        store(context, next)
        return next.profiles.firstOrNull { it.profileKey == next.activeKey }
    }

    private fun state(context: Context): ConnectionProfileState {
        val preferences = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
        val encoded = preferences.getString(PROFILES, null)
        if (encoded != null) {
            val profiles = runCatching {
                val array = JSONArray(encoded)
                (0 until array.length()).mapNotNull { index -> array.optJSONObject(index)?.toSettings() }
            }.getOrDefault(emptyList())
            return ConnectionProfileState(profiles, ConnectionProfiles.migratedActiveKey(profiles, preferences.getString(ACTIVE_PROFILE, null)))
        }
        if (!preferences.contains(RELAY_URL)) return ConnectionProfileState(emptyList(), null)
        val legacy = ConnectionSettings(
            relayUrl = preferences.getString(RELAY_URL, BuildConfig.DEFAULT_RELAY_URL).orEmpty(),
            hostId = preferences.getString(HOST_ID, BuildConfig.DEFAULT_HOST_ID).orEmpty(),
            secret = preferences.getString(SECRET, "").orEmpty(),
            tlsFingerprint = preferences.getString(TLS_FINGERPRINT, "").orEmpty(),
            hostName = preferences.getString(HOST_NAME, "").orEmpty(),
        )
        return ConnectionProfileState(listOf(legacy), legacy.profileKey)
    }

    private fun store(context: Context, state: ConnectionProfileState) {
        val array = JSONArray()
        state.profiles.forEach { settings -> array.put(settings.toJson()) }
        val active = state.profiles.firstOrNull { it.profileKey == state.activeKey } ?: state.profiles.firstOrNull()
        context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE).edit {
            putString(PROFILES, array.toString())
            if (active == null) {
                remove(ACTIVE_PROFILE)
                remove(RELAY_URL)
                remove(HOST_ID)
                remove(SECRET)
                remove(TLS_FINGERPRINT)
                remove(HOST_NAME)
            } else {
                putString(ACTIVE_PROFILE, active.profileKey)
                putString(RELAY_URL, active.relayUrl)
                putString(HOST_ID, active.hostId)
                putString(SECRET, active.secret)
                putString(TLS_FINGERPRINT, active.normalizedFingerprint)
                putString(HOST_NAME, active.hostName)
            }
        }
    }

    /** Allows local ADB smoke tests to configure a debug build without committing credentials. */
    fun applyDebugIntent(context: Context, intent: Intent?): Boolean {
        if (!BuildConfig.DEBUG || intent == null || !intent.hasExtra(DEBUG_RELAY_URL)) return false
        val current = load(context)
        val candidate = ConnectionSettings(
            relayUrl = intent.getStringExtra(DEBUG_RELAY_URL) ?: current.relayUrl,
            hostId = intent.getStringExtra(DEBUG_HOST_ID) ?: current.hostId,
            secret = intent.getStringExtra(DEBUG_SECRET) ?: current.secret,
            tlsFingerprint = intent.getStringExtra(DEBUG_TLS_FINGERPRINT) ?: current.tlsFingerprint,
        )
        if (candidate.validationError() != null) return false
        save(context, candidate)
        intent.removeExtra(DEBUG_RELAY_URL)
        intent.removeExtra(DEBUG_HOST_ID)
        intent.removeExtra(DEBUG_SECRET)
        intent.removeExtra(DEBUG_TLS_FINGERPRINT)
        return true
    }

    private fun defaults(): ConnectionSettings = ConnectionSettings(
        relayUrl = BuildConfig.DEFAULT_RELAY_URL,
        hostId = BuildConfig.DEFAULT_HOST_ID,
        secret = "",
        tlsFingerprint = "",
    )

    private fun ConnectionSettings.toJson(): JSONObject = JSONObject()
        .put("relayUrl", relayUrl)
        .put("hostId", hostId)
        .put("secret", secret)
        .put("tlsFingerprint", normalizedFingerprint)
        .put("hostName", hostName)
        .put("connectionEnabled", connectionEnabled)
        .put("profileAlias", profileAlias)
        .put("networkPolicy", networkPolicy.wireName)
        .put("connectionMode", connectionMode?.value)

    private fun JSONObject.toSettings(): ConnectionSettings? {
        val relayUrl = optString("relayUrl")
        if (relayUrl.isBlank()) return null
        return ConnectionSettings(
            relayUrl = relayUrl,
            hostId = optString("hostId"),
            secret = optString("secret"),
            tlsFingerprint = optString("tlsFingerprint"),
            hostName = optString("hostName"),
            connectionEnabled = optBoolean("connectionEnabled", true),
            profileAlias = optString("profileAlias"),
            networkPolicy = HostNetworkPolicy.fromWire(optString("networkPolicy")),
            connectionMode = ConnectionMode.entries.firstOrNull { it.value == optString("connectionMode") },
        ).normalized()
    }
}

const val MAX_PROFILE_ALIAS_LENGTH = 64
