package com.termbridge.android.brain

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class GlobalCallLaunchGateTest {
    @Test
    fun `waits for the Brain connection before consuming a request`() {
        val gate = GlobalCallLaunchGate()

        gate.request()

        assertFalse(gate.consumeIfReady(ready = false, callActive = false))
        assertTrue(gate.consumeIfReady(ready = true, callActive = false))
        assertFalse(gate.consumeIfReady(ready = true, callActive = false))
    }

    @Test
    fun `a request received during a call does not restart it later`() {
        val gate = GlobalCallLaunchGate()

        gate.request()

        assertFalse(gate.consumeIfReady(ready = true, callActive = true))
        assertFalse(gate.consumeIfReady(ready = true, callActive = false))
    }
}
