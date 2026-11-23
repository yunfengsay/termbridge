package com.termbridge.android.brain

import org.junit.Assert.*
import org.junit.Test

class VoiceWakeSessionTest {
    @Test fun `end word revokes upload immediately without ending the outstanding tool or answer`() {
        val session = VoiceWakeSession()
        session.start(VoiceInteractionMode.WAKE_WORD, 0)
        session.wake(1)
        val oldEpoch = session.generation
        session.toolActivity(true)
        assertTrue(session.finishInput())
        assertEquals(VoiceWakeSession.State.DRAINING, session.state)
        assertFalse(session.forward(oldEpoch) { fail("audio after stop word") })
        assertFalse(session.forward(session.generation) { fail("new epoch is not a microphone grant") })
        assertTrue(session.canDrainAuthorizedAudio)
        assertFalse(session.shouldPark(150_000, false, false))
        session.toolActivity(false)
        session.responseStarted()
        session.responseFinished(true, 151_000)
        assertFalse(session.shouldPark(152_000, true, false))
        assertTrue(session.shouldPark(152_000, false, false))
    }

    @Test fun `new wake may resume input while the previous result is still pending`() {
        val session = VoiceWakeSession()
        session.start(VoiceInteractionMode.WAKE_WORD, 0)
        session.wake(1)
        val oldEpoch = session.generation
        session.finishInput()
        assertTrue(session.wake(2))
        assertFalse(session.forward(oldEpoch) { fail("late frame from previous input") })
        assertTrue(session.forward(session.generation) {})
        session.stop()
        assertFalse(session.canDrainAuthorizedAudio)
        assertFalse(session.wake(3))
    }

    @Test fun `standby never sends or queues audio and wake grants only the current generation`() {
        val session = VoiceWakeSession()
        session.start(VoiceInteractionMode.WAKE_WORD, 0)
        val old = session.generation
        var bytes = 0
        repeat(10_000) { assertFalse(session.forward(old) { bytes += 1024 }) }
        assertEquals(0, bytes)
        assertTrue(session.wake(100))
        assertFalse(session.wake(101))
        assertFalse(session.forward(old) { bytes++ })
        assertTrue(session.forward(session.generation) { bytes += 1024 })
        session.park()
        assertFalse(session.forward(session.generation) { bytes++ })
        assertEquals(1024, bytes)
    }

    @Test fun `waits for AI answer and playback drain not just a pause or tool call`() {
        val session = VoiceWakeSession()
        session.start(VoiceInteractionMode.WAKE_WORD, 0)
        session.wake(1)
        assertFalse(session.shouldPark(10_000, false, false))
        session.responseFinished(false, 10_000)
        assertFalse(session.shouldPark(11_000, false, false))
        session.responseStarted()
        session.responseFinished(true, 12_000)
        assertFalse(session.shouldPark(13_000, true, false))
        assertFalse(session.shouldPark(13_000, false, true))
        assertTrue(session.shouldPark(13_000, false, false))
        session.userSpeech()
        assertFalse(session.shouldPark(13_001, false, false))
        session.toolActivity(true)
        session.responseStarted()
        session.responseFinished(true, 13_001)
        assertFalse(session.shouldPark(14_000, false, false))
    }

    @Test fun `continuous mode does not park and hangup revokes queued callbacks`() {
        val session = VoiceWakeSession()
        session.start(VoiceInteractionMode.CONTINUOUS, 0)
        val epoch = session.generation
        session.responseFinished(true, 1)
        assertFalse(session.shouldPark(1_000_000, false, false))
        session.stop()
        assertFalse(session.forward(epoch) { fail("stale callback") })
        assertFalse(session.wake(2))
        session.start(VoiceInteractionMode.WAKE_WORD, 3)
        assertFalse(session.forward(epoch) { fail("old mode") })
    }

    @Test fun `network or provider failure cannot leave a wake window open forever`() {
        val session = VoiceWakeSession()
        session.start(VoiceInteractionMode.WAKE_WORD, 0)
        session.wake(1)
        assertTrue(session.shouldSealInput(120_001))
        session.finishInput()
        assertFalse(session.forward(session.generation) { fail("expired microphone window") })
        assertFalse(session.shouldPark(120_001, true, true))
        assertEquals(VoiceWakeSession.State.DRAINING, session.state)
    }

    @Test fun `late finish from an interrupted reply must not park while user continues speaking`() {
        val session = VoiceWakeSession()
        session.start(VoiceInteractionMode.WAKE_WORD, 0)
        session.wake(1)
        session.userSpeech()
        session.responseStarted()
        session.userSpeech()
        session.responseFinished(true, 2_000)
        assertFalse(session.shouldPark(3_000, false, false))
        session.responseStarted()
        session.responseFinished(true, 4_000)
        assertTrue(session.shouldPark(5_000, false, false))
    }
}
