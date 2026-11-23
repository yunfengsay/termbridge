package com.termbridge.android.brain

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class VoiceAudioOutboxTest {
    @Test
    fun `replays an interrupted utterance from its first audio frame`() {
        val outbox = VoiceAudioOutbox(maxBytes = 64)
        val sent = mutableListOf<String>()

        assertTrue(outbox.offerAudio(byteArrayOf(1, 2)))
        assertTrue(outbox.flush(
            sendAudio = { sent += "audio:${it.joinToString()}"; true },
            sendCommit = { sent += "commit"; true },
        ))
        assertTrue(outbox.offerAudio(byteArrayOf(3, 4)))
        outbox.beginNewRemoteSession()
        assertTrue(outbox.offerCommit())

        sent.clear()
        assertTrue(outbox.flush(
            sendAudio = { sent += "audio:${it.joinToString()}"; true },
            sendCommit = { sent += "commit"; true },
        ))

        assertEquals(listOf("audio:1, 2", "audio:3, 4", "commit"), sent)
        assertEquals(1, outbox.pendingTurnCount)
    }

    @Test
    fun `holds later offline turns until the prior transcript is acknowledged`() {
        val outbox = VoiceAudioOutbox(maxBytes = 64)
        outbox.offerAudio(byteArrayOf(1, 2))
        outbox.offerCommit()
        outbox.offerAudio(byteArrayOf(3, 4))
        outbox.offerCommit()
        val sent = mutableListOf<String>()

        assertTrue(outbox.flush(
            sendAudio = { sent += "audio:${it.first()}"; true },
            sendCommit = { sent += "commit"; true },
        ))
        assertEquals(listOf("audio:1", "commit"), sent)

        outbox.acknowledgeTranscript()
        assertTrue(outbox.flush(
            sendAudio = { sent += "audio:${it.first()}"; true },
            sendCommit = { sent += "commit"; true },
        ))
        assertEquals(listOf("audio:1", "commit", "audio:3", "commit"), sent)
        assertEquals(1, outbox.pendingTurnCount)
    }

    @Test
    fun `keeps unsent data after transport failure and enforces a byte bound`() {
        val outbox = VoiceAudioOutbox(maxBytes = 4)
        assertTrue(outbox.offerAudio(byteArrayOf(1, 2)))
        assertFalse(outbox.flush(sendAudio = { false }, sendCommit = { true }))
        assertTrue(outbox.hasPending)
        assertTrue(outbox.offerAudio(byteArrayOf(3, 4)))
        assertFalse(outbox.offerAudio(byteArrayOf(5, 6)))
        assertEquals(4, outbox.queuedBytes)
    }
}
