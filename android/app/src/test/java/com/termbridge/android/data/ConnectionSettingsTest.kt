package com.termbridge.android.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ConnectionSettingsTest {
    @Test
    fun acceptsWebSocketUrlsAndColonSeparatedFingerprint() {
        val settings = ConnectionSettings(
            relayUrl = "wss://relay.example.com:8001",
            hostId = "host",
            secret = "secret",
            tlsFingerprint = (0 until 32).joinToString(":") { "AB" },
        )

        assertNull(settings.validationError())
        assertEquals("ab".repeat(32), settings.normalizedFingerprint)
    }

    @Test
    fun rejectsHttpAndShortPins() {
        assertEquals(
            "Relay URL must start with ws:// or wss://",
            ConnectionSettings("https://example.com", "", "", "").validationError(),
        )
        assertEquals(
            "TLS fingerprint must contain 64 hexadecimal characters",
            ConnectionSettings("ws://localhost:7400", "", "", "abcd").validationError(),
        )
    }
}
