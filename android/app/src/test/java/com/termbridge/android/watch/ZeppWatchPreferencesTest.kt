package com.termbridge.android.watch

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ZeppWatchPreferencesTest {
    @Test
    fun watchVoiceRequiresConfirmationByDefault() {
        assertTrue(ZeppWatchPreferences().confirmVoiceBeforeSend)
        assertFalse(ZeppWatchPreferences(confirmVoiceBeforeSend = false).confirmVoiceBeforeSend)
    }

    @Test
    fun notificationClassesCanBeRoutedIndependently() {
        val preferences = ZeppWatchPreferences(
            notifyAttention = true,
            notifyFailure = false,
            notifyCompletion = true,
        )

        assertTrue(preferences.allows("approval"))
        assertTrue(preferences.allows("blocked"))
        assertFalse(preferences.allows("failed"))
        assertFalse(preferences.allows("error"))
        assertTrue(preferences.allows("done"))
        assertFalse(preferences.allows("working"))
    }
}
