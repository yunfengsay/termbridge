package com.termbridge.android.brain

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class VoiceConversationTest {
    @Test
    fun `continuous turn returns to listening after TTS`() {
        val conversation = VoiceConversation()
        conversation.start()
        assertEquals(VoiceConversationState.LISTENING, conversation.state)
        conversation.recordingFinished()
        conversation.transcriptionSent()
        conversation.brainAnswerStarted()
        assertTrue(conversation.speechFinished())
        assertEquals(VoiceConversationState.LISTENING, conversation.state)
    }

    @Test
    fun `stopped conversation does not restart after late TTS callback`() {
        val conversation = VoiceConversation()
        conversation.start()
        conversation.brainAnswerStarted()
        conversation.stop()
        assertFalse(conversation.speechFinished())
        assertEquals(VoiceConversationState.STOPPED, conversation.state)
    }

    @Test
    fun `silence detector stops only after speech and trailing silence`() {
        val detector = VoiceSilenceDetector(sampleRate = 1_000, trailingSilenceMs = 1_000, maximumMs = 10_000)
        assertFalse(detector.accept(ShortArray(500), 500))
        assertFalse(detector.accept(ShortArray(300) { 2_000 }, 300))
        assertFalse(detector.accept(ShortArray(900), 900))
        assertTrue(detector.accept(ShortArray(100), 100))
    }
}
