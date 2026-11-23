package com.termbridge.android.data

import com.termbridge.android.network.LanConnection
import org.junit.Assert.*
import org.junit.Test

class LanConnectionTest {
    @Test fun lanEndpointsUseWsWithoutClassifyingPublicIPAsPrivate() {
        assertEquals("ws://192.168.1.20:7400", LanConnection.url(" 192.168.1.20 ", "7400"))
        listOf("10.0.0.2", "172.16.0.1", "172.31.255.255", "169.254.1.2").forEach { assertTrue(LanConnection.isPrivateIPv4(it)) }
        listOf("8.8.8.8", "010.0.0.1", "172.32.1.1", "192.168.1.256", "host.example", "192.168.1.1/path", "1.2.3").forEach { assertFalse(LanConnection.isPrivateIPv4(it)) }
        assertEquals("ws://30.20.30.40:7400", LanConnection.url("30.20.30.40", "7400"))
        assertEquals("wss://30.20.30.40:7400", LanConnection.url("30.20.30.40", "7400", useTls = true))
        assertFalse(LanConnection.isPrivateIPv4("30.20.30.40"))
        assertThrows(IllegalArgumentException::class.java) { LanConnection.url("224.0.0.1", "7400") }
        assertThrows(IllegalArgumentException::class.java) { LanConnection.url("192.168.1.2", "80") }
    }

    @Test fun explicitDirectProfilesBypassAppProxiesWhateverTheirAddressRange() {
        fun profile(url: String, mode: ConnectionMode?) = ConnectionSettings(url, "", "1122", "", connectionMode = mode)
        assertTrue(profile("ws://30.20.30.40:7400", ConnectionMode.DIRECT).bypassesAppProxy)
        assertTrue(profile("ws://192.168.1.20:7400", null).bypassesAppProxy)
        assertTrue(profile("wss://192.168.1.20:8001", ConnectionMode.RELAY).bypassesAppProxy)
        assertFalse(profile("wss://203.0.113.10:8001", ConnectionMode.RELAY).bypassesAppProxy)
        assertFalse(profile("ws://30.20.30.40:7400", null).bypassesAppProxy)
    }
}
