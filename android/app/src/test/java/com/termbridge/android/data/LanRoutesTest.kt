package com.termbridge.android.data

import com.termbridge.android.network.LanRoute
import com.termbridge.android.network.LanRouteResult
import com.termbridge.android.network.LanRoutes
import org.junit.Assert.*
import org.junit.Test

class LanRoutesTest {
    private fun route(label: String) = LanRoute(label, null)

    @Test fun firstConnectedRouteWinsWithoutWaitingForASlowerOne() {
        val started = System.nanoTime()
        val (winner, _) = LanRoutes.race(listOf(route("vpn"), route("wifi"))) { route ->
            if (route.label == "vpn") { Thread.sleep(3_000); LanRouteResult(route, false, 3_000, error = "timeout") }
            else { Thread.sleep(50); LanRouteResult(route, true, 50, "30.7.0.2") }
        }
        assertEquals("wifi", winner?.route?.label)
        assertTrue("A proxy VPN that cannot reach the Mac must not delay the working route",
            (System.nanoTime() - started) / 1_000_000 < 2_000)
    }

    @Test fun onlyARealHttpStatusLineCountsAsAServerAnswer() {
        assertEquals(101, LanRoutes.httpStatus("HTTP/1.1 101 Switching Protocols"))
        assertEquals(426, LanRoutes.httpStatus("HTTP/1.0 426"))
        listOf("", "SSH-2.0-OpenSSH", "HTTP/2 200", "HTTP/1.1 20", "\u0016\u0003\u0001").forEach { assertNull(it, LanRoutes.httpStatus(it)) }
    }

    @Test fun noConnectedRouteReportsEveryFailure() {
        val (winner, results) = LanRoutes.race(listOf(route("vpn"), route("wifi"))) { route ->
            LanRouteResult(route, false, 1, error = if (route.label == "wifi") "EPERM" else "timeout")
        }
        assertNull(winner)
        assertEquals(mapOf("vpn" to "timeout", "wifi" to "EPERM"), results.associate { it.route.label to it.error })
    }
}
