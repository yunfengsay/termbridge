package com.termbridge.android.watch

/** One reconnect schedule shared by every event that may wake the watch gateway. */
internal class WatchReconnectBackoff(
    private val delaysMillis: LongArray = longArrayOf(3_000, 10_000, 30_000, 60_000, 180_000, 300_000),
) {
    private var failures = 0

    fun nextDelayMillis(): Long {
        val delay = delaysMillis[failures.coerceAtMost(delaysMillis.lastIndex)]
        failures++
        return delay
    }

    fun reset() {
        failures = 0
    }
}
