package com.termbridge.android.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.URLEncoder
import java.nio.charset.StandardCharsets

class PairingCodeTest {
    @Test fun passwordOnlyLanPairingRequiresExplicitDirectMode() {
        val base = "termbridge://pair?v=1&relay=ws%3A%2F%2F30.20.30.40%3A7400&secret=2468"
        val settings = PairingCode.parse("$base&mode=direct")
        assertEquals("ws://30.20.30.40:7400", settings.relayUrl)
        assertEquals("2468", settings.secret)
        assertEquals("", settings.tlsFingerprint)
        assertTrue(settings.isDirectConnection)
        assertThrows(IllegalArgumentException::class.java) { PairingCode.parse(base) }
        assertThrows(IllegalArgumentException::class.java) { PairingCode.parse("$base&mode=relay") }
        assertThrows(IllegalArgumentException::class.java) { PairingCode.parse("$base&mode=direct&pin=${"a".repeat(64)}") }
    }
    @Test fun shortPasswordsAndExplicitDirectModePreserveRelayDefaults() {
        val base = "termbridge://pair?v=1&relay=wss%3A%2F%2F203.0.113.8%3A8001&secret=2468"
        val relay = PairingCode.parse(base)
        assertEquals("2468", relay.secret)
        assertFalse(relay.isDirectConnection)
        assertTrue(PairingCode.parse("$base&mode=direct").isDirectConnection)
        assertFalse(PairingCode.parse("$base&mode=relay").isDirectConnection)
        assertThrows(IllegalArgumentException::class.java) { PairingCode.parse("$base&mode=unknown") }
        assertThrows(IllegalArgumentException::class.java) { PairingCode.parse("tb1_2468") }
    }
    private val room = "a".repeat(64)
    private val secret = "MDEyMzQ1Njc4OWFiY2RlZmdoaWprbG1ub3BxcnN0dXY"
    private val pin = "b".repeat(64)

    @Test
    fun parsesCloudflarePairingQr() {
        val relay = "wss://relay.example/r/$room"
        val encoded = URLEncoder.encode(relay, StandardCharsets.UTF_8.name())
        val settings = PairingCode.parse("termbridge://pair?v=1&relay=$encoded&secret=$secret&host=mac-home&name=Home%20Mac&pin=$pin")
        assertEquals(relay, settings.relayUrl)
        assertEquals(secret, settings.secret)
        assertEquals("mac-home", settings.hostId)
        assertEquals("Home Mac", settings.hostName)
        assertEquals(pin, settings.tlsFingerprint)
        assertTrue(PairingCode.isHostedRoom(settings.relayUrl))
    }

    @Test
    fun rejectsNonPairingAndInsecurePayloads() {
        assertThrows(IllegalArgumentException::class.java) { PairingCode.parse("https://example.com") }
        assertThrows(IllegalArgumentException::class.java) {
            PairingCode.parse("termbridge://pair?v=1&relay=ws%3A%2F%2Flocalhost&secret=$secret")
        }
        assertThrows(IllegalArgumentException::class.java) {
            PairingCode.parse("termbridge://pair?v=1&relay=wss%3A%2F%2Frelay.example&secret=$secret&pin=deadbeef")
        }
        assertFalse(PairingCode.isHostedRoom("wss://relay.example/"))
    }
}
