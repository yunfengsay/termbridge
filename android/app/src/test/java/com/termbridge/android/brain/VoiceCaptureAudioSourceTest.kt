package com.termbridge.android.brain

import android.media.MediaRecorder
import org.junit.Assert.assertEquals
import org.junit.Test

class VoiceCaptureAudioSourceTest {
    @Test
    fun `realtime calls use the vendor voice communication AEC path`() {
        assertEquals(
            MediaRecorder.AudioSource.VOICE_COMMUNICATION,
            voiceCaptureAudioSource(),
        )
    }

    @Test
    fun `all voice capture stays on one communication processing path`() {
        assertEquals(
            MediaRecorder.AudioSource.VOICE_COMMUNICATION,
            voiceCaptureAudioSource(),
        )
    }
}
