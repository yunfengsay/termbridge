package com.termbridge.android.data

import java.net.URI
import java.net.URLDecoder
import java.nio.charset.StandardCharsets

object PairingCode {
    const val ROOM_KEY_HEADER = "X-Termbridge-Room-Key"
    private val roomPath = Regex("^/r/[a-fA-F0-9]{64}$")

    fun parse(value: String): ConnectionSettings {
        val uri = runCatching { URI(value.trim()) }.getOrNull()
            ?: throw IllegalArgumentException("This is not a Termbridge pairing QR")
        if (uri.scheme != "termbridge" || uri.host != "pair") {
            throw IllegalArgumentException("This is not a Termbridge pairing QR")
        }
        val fields = uri.rawQuery.orEmpty().split('&').mapNotNull { field ->
            val separator = field.indexOf('=')
            if (separator < 0) null else decode(field.substring(0, separator)) to decode(field.substring(separator + 1))
        }.toMap()
        if (fields["v"] != "1") throw IllegalArgumentException("This pairing QR version is not supported")
        val relay = fields["relay"].orEmpty()
        val secret = fields["secret"].orEmpty()
        val hostId = fields["host"].orEmpty()
        val hostName = fields["name"].orEmpty()
        val tlsFingerprint = fields["pin"].orEmpty()
        val modeValue = fields["mode"]
        val mode = ConnectionMode.entries.firstOrNull { it.value == modeValue }
        require(modeValue == null || mode != null) { "Invalid connection mode" }
        val relayUri = runCatching { URI(relay) }.getOrNull()
        val plainDirect = relayUri?.scheme == "ws" && mode == ConnectionMode.DIRECT
        if ((!plainDirect && relayUri?.scheme != "wss") || relayUri?.host.isNullOrBlank()) {
            throw IllegalArgumentException("Pairing requires a wss:// server or explicit ws:// LAN direct mode")
        }
        require(!plainDirect || tlsFingerprint.isEmpty()) { "A ws:// LAN connection cannot have a TLS fingerprint" }
        if (secret.length !in 1..256) throw IllegalArgumentException("The pairing key is invalid")
        if (hostId.isNotEmpty() && !hostId.matches(Regex("^[a-zA-Z0-9._:-]{1,128}$"))) {
            throw IllegalArgumentException("The pairing host ID is invalid")
        }
        if (hostName.length > 128) throw IllegalArgumentException("The pairing host name is too long")
        if (tlsFingerprint.isNotEmpty() && !tlsFingerprint.matches(Regex("^[a-fA-F0-9]{64}$"))) {
            throw IllegalArgumentException("The pairing TLS fingerprint is invalid")
        }
        return ConnectionSettings(
            relayUrl = relay,
            hostId = hostId,
            secret = secret,
            tlsFingerprint = tlsFingerprint.lowercase(),
            hostName = hostName,
            connectionMode = mode,
            networkPolicy = if (mode == ConnectionMode.DIRECT) com.termbridge.android.protocol.HostNetworkPolicy.DIRECT
                else com.termbridge.android.protocol.HostNetworkPolicy.SYSTEM,
        )
    }

    fun isHostedRoom(relayUrl: String): Boolean {
        val uri = runCatching { URI(relayUrl.trim()) }.getOrNull() ?: return false
        return uri.scheme.equals("wss", ignoreCase = true) && roomPath.matches(uri.path.orEmpty())
    }

    private fun decode(value: String): String =
        URLDecoder.decode(value, StandardCharsets.UTF_8.name())
}
