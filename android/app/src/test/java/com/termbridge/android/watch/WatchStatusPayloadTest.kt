package com.termbridge.android.watch

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class WatchStatusPayloadTest {
    @Test
    fun `battery status is exactly one bounded byte`() {
        assertEquals(0, WatchStatusPayload.decode(byteArrayOf(0)).batteryLevel)
        assertEquals(73, WatchStatusPayload.decode(byteArrayOf(73)).batteryLevel)
        assertEquals(100, WatchStatusPayload.decode(byteArrayOf(100)).batteryLevel)
    }

    @Test
    fun `battery status rejects missing extra or out of range data`() {
        assertThrows(IllegalArgumentException::class.java) {
            WatchStatusPayload.decode(byteArrayOf())
        }
        assertThrows(IllegalArgumentException::class.java) {
            WatchStatusPayload.decode(byteArrayOf(50, 1))
        }
        assertThrows(IllegalArgumentException::class.java) {
            WatchStatusPayload.decode(byteArrayOf(101))
        }
    }
}
