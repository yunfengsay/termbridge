package com.termbridge.android.brain

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class VoiceSettingsStoreTest {
    @Test
    fun `voice provider preference is stable on the wire and defaults to Bailian`() {
        assertEquals(VoiceProviderPreference.BAILIAN, VoiceProviderPreference.from(null))
        assertEquals(VoiceProviderPreference.BAILIAN, VoiceProviderPreference.from("unknown"))
        assertEquals(VoiceProviderPreference.BAILIAN, VoiceProviderPreference.from("BAILIAN"))
        assertEquals(VoiceProviderPreference.VOLCENGINE, VoiceProviderPreference.from("volcengine"))
    }

    @Test
    fun `normalizes surrounding punctuation and blank values`() {
        assertEquals("完成", VoiceSettingsStore.normalizeKeyword("  完成。 "))
        assertEquals(VoiceSettingsStore.DEFAULT_SEND_KEYWORD, VoiceSettingsStore.normalizeKeyword("  "))
        assertEquals(VoiceSettingsStore.DEFAULT_SEND_KEYWORD, VoiceSettingsStore.normalizeKeyword(null))
    }

    @Test
    fun `normalizes playback rate to a supported choice`() {
        assertEquals(1.5f, VoiceSettingsStore.normalizePlaybackRate(1.49f))
        assertEquals(3f, VoiceSettingsStore.normalizePlaybackRate(8f))
    }

    @Test
    fun `normalizes technical terms while preserving canonical spelling`() {
        assertEquals(
            listOf("Token", "LLM", "Skill", "Agent"),
            VoiceSettingsStore.normalizeTechnicalTerms(" Token, LLM\nSkill，Agent;token "),
        )
        assertEquals(emptyList<String>(), VoiceSettingsStore.normalizeTechnicalTerms(" ,；\n"))
    }

    @Test
    fun `default technical terms contain no product specific replacement rules`() {
        assertTrue(VoiceSettingsStore.DEFAULT_TECHNICAL_TERMS.contains("Token"))
        assertFalse(VoiceSettingsStore.DEFAULT_TECHNICAL_TERMS.any { '=' in it || '|' in it })
    }
}
