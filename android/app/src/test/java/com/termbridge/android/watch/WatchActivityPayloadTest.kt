package com.termbridge.android.watch

import com.termbridge.android.protocol.MessagePackCodec
import org.junit.Assert.assertEquals
import org.junit.Test

class WatchActivityPayloadTest {
    @Test
    fun `activity snapshot uses scaled integers and stable field names`() {
        val bytes = WatchActivitySnapshot(
            active = true,
            paused = false,
            elapsedSeconds = 367,
            speedCentiKph = 2875,
            distanceMeters = 4912,
            elevationDecimeters = 1234,
            gpsAccuracyDecimeters = 28,
            heartRate = 148,
            cadence = 87,
            label = "午间骑行",
        ).encode()
        val map = MessagePackCodec.unpackMap(bytes)
        assertEquals(2L, map["version"])
        assertEquals(2875L, map["speedCentiKph"])
        assertEquals(4912L, map["distanceMeters"])
        assertEquals(148L, map["heartRate"])
    }

    @Test
    fun `actions preserve exact work session identity`() {
        val bytes = MessagePackCodec.packMap(
            linkedMapOf(
                "version" to 1,
                "action" to "continue",
                "hostId" to "office-mini",
                "sessionId" to "herdr:wA:p3",
            ),
        )
        assertEquals(WatchAction("continue", "office-mini", "herdr:wA:p3"), WatchAction.decode(bytes))
    }

    @Test
    fun `activity v2 preserves elevation below sea level`() {
        val map = MessagePackCodec.unpackMap(
            WatchActivitySnapshot(false, false, 0, 0, 0, -430, 0).encode(),
        )
        assertEquals(99_570L, map["elevationDecimeters"])
    }

    @Test
    fun `motion status decodes steps and active time`() {
        val bytes = MessagePackCodec.packMap(
            linkedMapOf("version" to 1, "steps" to 12_345, "activeMinutes" to 86),
        )
        assertEquals(WatchMotionStatus(12_345, 86), WatchMotionStatus.decode(bytes))
    }
}
