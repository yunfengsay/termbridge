package com.termbridge.android.chat

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The counter-example this exists for: the picker returns, the image finishes
 * encoding, and the flush lands between `agent_chat_subscribe` going out and
 * the Host answering it. The Host is still awaiting describe/locate there, so
 * it refuses the upload — and the client acknowledges the refusal, which drops
 * the picture. Treating "request sent" as authorization is what loses it.
 */
class SessionUploadGateTest {
    @Test
    fun anEncodeThatFinishesBeforeTheHostAnswersDoesNotUpload() {
        val gate = SessionUploadGate()
        gate.requested()
        // The socket is up and the subscribe frame is on the wire. Not enough.
        assertFalse(gate.allows(1))

        gate.confirmed(1)
        assertTrue(gate.allows(1))
    }

    @Test
    fun aGrantBelongsToTheGenerationThatEarnedIt() {
        val gate = SessionUploadGate()
        gate.confirmed(1)
        // Re-subscribing starts a new generation the Host has not answered yet.
        gate.requested()
        assertFalse(gate.allows(2))
        // And the old generation's grant does not come back either.
        assertFalse(gate.allows(1))

        gate.confirmed(2)
        assertTrue(gate.allows(2))
        assertFalse(gate.allows(1))
    }

    @Test
    fun losingTheConnectionOrDegradingRevokesImmediately() {
        val gate = SessionUploadGate()
        gate.confirmed(3)
        assertTrue(gate.allows(3))
        gate.revoked()
        assertFalse(gate.allows(3))
    }
}
