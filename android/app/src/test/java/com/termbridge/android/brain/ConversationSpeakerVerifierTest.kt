package com.termbridge.android.brain

import org.junit.Assert.assertTrue
import org.junit.Test

class ConversationSpeakerVerifierTest {
    @Test
    fun `recent verified voice bridges acoustic drift from the enrolled profile`() {
        val enrolledProfile = floatArrayOf(1f, 0f)
        val firstTurn = floatArrayOf(0.6f, 0.8f)
        val bargeInTurn = floatArrayOf(0f, 1f)
        val verifier = ConversationSpeakerVerifier(enrolledProfile)

        assertTrue(verifier.similarity(firstTurn) >= TargetSpeakerTracker.AUTHORIZATION_THRESHOLD)
        verifier.remember(firstTurn)
        assertTrue(VoiceEmbedding.similarity(enrolledProfile, bargeInTurn) < TargetSpeakerTracker.AUTHORIZATION_THRESHOLD)
        assertTrue(verifier.similarity(bargeInTurn) >= TargetSpeakerTracker.AUTHORIZATION_THRESHOLD)
    }

    @Test
    fun `conversation anchor does not admit an unrelated opposite voice`() {
        val verifier = ConversationSpeakerVerifier(floatArrayOf(1f, 0f))
        verifier.remember(floatArrayOf(0.8f, 0.6f))

        assertTrue(verifier.similarity(floatArrayOf(-1f, 0f)) < TargetSpeakerTracker.AUTHORIZATION_THRESHOLD)
    }
}
