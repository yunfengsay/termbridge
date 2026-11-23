package com.termbridge.android.watch

import org.junit.Assert.assertEquals
import org.junit.Test

class WatchReconnectBackoffTest {
    @Test
    fun `reconnect backs off while devices stay apart and resets after success`() {
        val backoff = WatchReconnectBackoff(longArrayOf(3, 10, 30))
        assertEquals(3, backoff.nextDelayMillis())
        assertEquals(10, backoff.nextDelayMillis())
        assertEquals(30, backoff.nextDelayMillis())
        assertEquals(30, backoff.nextDelayMillis())
        backoff.reset()
        assertEquals(3, backoff.nextDelayMillis())
    }
}
