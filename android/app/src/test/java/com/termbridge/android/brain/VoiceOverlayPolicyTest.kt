package com.termbridge.android.brain

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class VoiceOverlayPolicyTest {
    @Test
    fun `permission alone never permits an invisible background call`() {
        assertFalse(VoiceOverlayPolicy.canRetain(true, false, false))
        assertTrue(VoiceOverlayPolicy.canRetain(true, true, false))
        assertTrue(VoiceOverlayPolicy.canRetain(true, false, true))
        assertFalse(VoiceOverlayPolicy.canRetain(false, true, true))
    }
    @Test
    fun `active call becomes an overlay only outside the app with permission`() {
        assertTrue(VoiceOverlayPolicy.shouldShow(callActive = true, appForeground = false, overlayAllowed = true))
        assertFalse(VoiceOverlayPolicy.shouldShow(callActive = true, appForeground = true, overlayAllowed = true))
        assertFalse(VoiceOverlayPolicy.shouldShow(callActive = true, appForeground = false, overlayAllowed = false))
        assertFalse(VoiceOverlayPolicy.shouldShow(callActive = false, appForeground = false, overlayAllowed = true))
    }
}
