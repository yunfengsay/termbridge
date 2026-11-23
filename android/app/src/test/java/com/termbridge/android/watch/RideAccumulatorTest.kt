package com.termbridge.android.watch

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class RideAccumulatorTest {
    @Test
    fun `ride keeps distance and excludes paused movement`() {
        var now = 1_000L
        val ride = RideAccumulator { now }
        ride.start()
        ride.add(RidePoint(31.2304, 121.4737, 8.0, 3f, 5f, now))
        now += 10_000
        ride.add(RidePoint(31.2314, 121.4737, 9.0, 3f, 5f, now))
        val beforePause = ride.snapshot()
        assertTrue(beforePause.distanceMeters in 105..117)
        assertEquals(1_800, beforePause.speedCentiKph)

        ride.pause()
        now += 20_000
        ride.add(RidePoint(31.2400, 121.4737, 20.0, 3f, 5f, now))
        assertEquals(beforePause.distanceMeters, ride.snapshot().distanceMeters)
        ride.resume()
        assertEquals(10, ride.snapshot().elapsedSeconds)
    }

    @Test
    fun `poor accuracy samples do not inflate a ride`() {
        val ride = RideAccumulator { 1_000L }
        ride.start()
        ride.add(RidePoint(31.0, 121.0, 0.0, 80f, 20f, 1_000L))
        assertEquals(0, ride.snapshot().distanceMeters)
    }

    @Test
    fun `automatic pause excludes stopped time and final snapshot keeps duration`() {
        var now = 1_000L
        val ride = RideAccumulator { now }
        ride.start()
        ride.add(RidePoint(31.0, 121.0, 5.0, 3f, 5f, now))
        now += 10_000
        ride.add(RidePoint(31.001, 121.0, 5.0, 3f, 5f, now))
        now += 20_000
        ride.add(RidePoint(31.001, 121.0, 5.0, 3f, 0.1f, now))
        assertTrue(ride.snapshot().paused)
        assertEquals(10, ride.snapshot().elapsedSeconds)
        now += 30_000
        assertEquals(10, ride.snapshot().elapsedSeconds)
        ride.stop()
        assertEquals(10, ride.snapshot().elapsedSeconds)
    }

    @Test
    fun `rejected fix is not accepted for journaling`() {
        val ride = RideAccumulator { 1_000L }
        ride.start()
        assertEquals(false, ride.add(RidePoint(Double.NaN, 121.0, 0.0, 3f, 5f, 1_000L)))
        assertEquals(false, ride.add(RidePoint(31.0, 121.0, 0.0, 80f, 5f, 1_000L)))
    }
}
