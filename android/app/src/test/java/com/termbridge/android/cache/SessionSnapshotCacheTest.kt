package com.termbridge.android.cache

import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class SessionSnapshotCacheTest {
    @Test
    fun storesAndEvictsSnapshotsByLruAndBounds() {
        SessionSnapshotCache.clear()
        val payload = "{\"lines\":[]}".toByteArray()
        SessionSnapshotCache.putTerminal("host:a", "s1", 5, payload)
        val got = SessionSnapshotCache.getTerminal("host:a", "s1")!!
        assertEquals(5, got.revision)
        assertArrayEquals(payload, got.payload)

        // Oversized snapshot (> 256 KiB) is ignored safely.
        SessionSnapshotCache.putTerminal("host:a", "huge", 1, ByteArray(300 * 1024))
        assertNull(SessionSnapshotCache.getTerminal("host:a", "huge"))

        // Chat snapshot round-trip.
        SessionSnapshotCache.putChatRaw("host:a", "c1", "{\"op\":\"snapshot\",\"status\":\"idle\"}")
        assertEquals("{\"op\":\"snapshot\",\"status\":\"idle\"}", SessionSnapshotCache.getChatRaw("host:a", "c1"))
        SessionSnapshotCache.clear()
    }
}
