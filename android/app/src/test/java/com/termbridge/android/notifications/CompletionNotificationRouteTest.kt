package com.termbridge.android.notifications

import com.termbridge.android.data.ConnectionSettings
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test

class CompletionNotificationRouteTest {
    @Test
    fun `same pane on different hosts has a distinct notification destination`() {
        val home = CompletionNotificationRoute("home-mini", "herdr:w1:p1")
        val office = CompletionNotificationRoute("office-mini", "herdr:w1:p1")

        assertNotEquals(home.requestCode, office.requestCode)
    }

    @Test
    fun `opening a notification routes the terminal to its originating host`() {
        val current = ConnectionSettings(
            relayUrl = "wss://relay.example:8001",
            hostId = "home-mini",
            secret = "secret",
            tlsFingerprint = "",
        )

        val routed = CompletionNotificationRoute("office-mini", "herdr:w1:p1").applyTo(current)

        assertEquals("office-mini", routed.hostId)
        assertEquals("", routed.profileAlias)
        assertEquals(current.relayUrl, routed.relayUrl)
        assertEquals(current.secret, routed.secret)
    }

    @Test
    fun `saved Mac profile keeps its own relay and secret when notification is opened`() {
        val home = ConnectionSettings(
            relayUrl = "wss://home.example",
            hostId = "home-mini",
            secret = "home-secret",
            tlsFingerprint = "",
        )
        val office = ConnectionSettings(
            relayUrl = "wss://office.example",
            hostId = "office-mini",
            secret = "office-secret",
            tlsFingerprint = "",
        )

        val routed = CompletionNotificationRoute("office-mini", "herdr:w1:p1")
            .resolve(home, listOf(home, office))

        assertEquals(office, routed)
    }
}
