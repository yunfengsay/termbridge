package com.termbridge.android.brain

import android.content.Context
import androidx.core.content.edit
import java.util.Locale
import com.termbridge.android.protocol.BrainModelTier

data class VoiceSettings(
    val silentMode: Boolean = false,
    val silentModelTier: BrainModelTier = BrainModelTier.ADVANCED,
    val interactionMode: VoiceInteractionMode = VoiceInteractionMode.CONTINUOUS,
    val wakeWord: String = "你好小桥",
    val stopWords: List<String> = VoiceStopWords.DEFAULT,
    val boundaryLearningEnabled: Boolean = false,
    val adaptiveTurnControl: Boolean = true,
    val sendKeyword: String = VoiceSettingsStore.DEFAULT_SEND_KEYWORD,
    val playbackRate: Float = VoiceSettingsStore.DEFAULT_PLAYBACK_RATE,
    val provider: VoiceProviderPreference = VoiceProviderPreference.BAILIAN,
    val speakerVerificationEnabled: Boolean = VoiceSettingsStore.DEFAULT_SPEAKER_VERIFICATION_ENABLED,
    val speakerphoneEnabled: Boolean = VoiceSettingsStore.DEFAULT_SPEAKERPHONE_ENABLED,
    val keepScreenAwake: Boolean = VoiceSettingsStore.DEFAULT_KEEP_SCREEN_AWAKE,
    val noiseFilterEnabled: Boolean = VoiceSettingsStore.DEFAULT_NOISE_FILTER_ENABLED,
    val noiseSensitivity: VoiceNoiseSensitivity = VoiceNoiseSensitivity.CONSERVATIVE,
    val technicalTerms: List<String> = VoiceSettingsStore.DEFAULT_TECHNICAL_TERMS,
)

enum class VoiceProviderPreference(val wireValue: String) {
    AUTO("auto"),
    BAILIAN("bailian"),
    VOLCENGINE("volcengine");

    companion object {
        fun from(value: String?): VoiceProviderPreference = entries.firstOrNull {
            it.wireValue == value?.trim()?.lowercase(Locale.ROOT)
        } ?: BAILIAN
    }
}

class VoiceSettingsStore(context: Context) {
    private val preferences = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)

    fun load(): VoiceSettings = VoiceSettings(
        silentMode = preferences.getBoolean("silent_mode", false),
        silentModelTier = BrainModelTier.from(preferences.getString("silent_model_tier", null)),
        interactionMode = VoiceInteractionMode.from(preferences.getString("interaction_mode", null)),
        wakeWord = preferences.getString("wake_word", null) ?: "你好小桥",
        stopWords = runCatching { VoiceStopWords.parse(preferences.getString("stop_words", null).orEmpty()) }
            .getOrDefault(VoiceStopWords.DEFAULT),
        boundaryLearningEnabled = preferences.getBoolean("boundary_learning_enabled", false),
        adaptiveTurnControl = preferences.getBoolean("adaptive_turn_control", true),
        sendKeyword = normalizeKeyword(preferences.getString(KEY_SEND_KEYWORD, null)),
        playbackRate = normalizePlaybackRate(
            preferences.getFloat(KEY_PLAYBACK_RATE, DEFAULT_PLAYBACK_RATE),
        ),
        provider = VoiceProviderPreference.from(preferences.getString(KEY_PROVIDER, null)),
        speakerVerificationEnabled = preferences.getBoolean(
            KEY_SPEAKER_VERIFICATION_ENABLED,
            DEFAULT_SPEAKER_VERIFICATION_ENABLED,
        ),
        speakerphoneEnabled = preferences.getBoolean(
            KEY_SPEAKERPHONE_ENABLED,
            DEFAULT_SPEAKERPHONE_ENABLED,
        ),
        keepScreenAwake = preferences.getBoolean(KEY_KEEP_SCREEN_AWAKE, DEFAULT_KEEP_SCREEN_AWAKE),
        noiseFilterEnabled = preferences.getBoolean(KEY_NOISE_FILTER_ENABLED, DEFAULT_NOISE_FILTER_ENABLED),
        noiseSensitivity = VoiceNoiseSensitivity.from(preferences.getString(KEY_NOISE_SENSITIVITY, null)),
        technicalTerms = preferences.getString(KEY_TECHNICAL_TERMS, null)?.let {
            normalizeTechnicalTerms(it)
                .filter { term -> term.length <= MAX_TECHNICAL_TERM_LENGTH }
                .take(MAX_TECHNICAL_TERMS)
        } ?: DEFAULT_TECHNICAL_TERMS,
    )

    fun save(
        sendKeyword: String,
        playbackRate: Float,
        provider: VoiceProviderPreference,
        speakerVerificationEnabled: Boolean,
        technicalTermsText: String,
        keepScreenAwake: Boolean,
        noiseFilterEnabled: Boolean,
        noiseSensitivity: VoiceNoiseSensitivity,
        interactionMode: VoiceInteractionMode = load().interactionMode,
        wakeWord: String = load().wakeWord,
        stopWords: List<String> = load().stopWords,
    ): VoiceSettings {
        val normalizedWakeWord = OnDeviceWakeWord.validateKeyword(wakeWord)
        val normalizedStopWords = VoiceStopWords.parse(stopWords.joinToString("\n"))
        val keyword = cleanKeyword(sendKeyword)
        val technicalTerms = normalizeTechnicalTerms(technicalTermsText)
        require(keyword.isNotEmpty()) { "Send keyword cannot be empty" }
        require(keyword.length <= MAX_KEYWORD_LENGTH) { "Send keyword is too long" }
        require(playbackRate in PLAYBACK_RATES) { "Unsupported playback rate" }
        require(technicalTerms.size <= MAX_TECHNICAL_TERMS) {
            "Use at most $MAX_TECHNICAL_TERMS technical terms"
        }
        require(technicalTerms.all { it.length <= MAX_TECHNICAL_TERM_LENGTH }) {
            "Each technical term must be $MAX_TECHNICAL_TERM_LENGTH characters or fewer"
        }
        return VoiceSettings(
            silentMode = load().silentMode,
            silentModelTier = load().silentModelTier,
            interactionMode = interactionMode,
            wakeWord = normalizedWakeWord,
            stopWords = normalizedStopWords,
            boundaryLearningEnabled = load().boundaryLearningEnabled,
            adaptiveTurnControl = load().adaptiveTurnControl,
            sendKeyword = keyword,
            playbackRate = playbackRate,
            provider = provider,
            speakerVerificationEnabled = speakerVerificationEnabled,
            speakerphoneEnabled = load().speakerphoneEnabled,
            keepScreenAwake = keepScreenAwake,
            noiseFilterEnabled = noiseFilterEnabled,
            noiseSensitivity = noiseSensitivity,
            technicalTerms = technicalTerms,
        ).also {
            preferences.edit {
                putString("interaction_mode", it.interactionMode.value)
                putString("wake_word", it.wakeWord)
                putString("stop_words", it.stopWords.joinToString("\n"))
                putString(KEY_SEND_KEYWORD, it.sendKeyword)
                putFloat(KEY_PLAYBACK_RATE, it.playbackRate)
                putString(KEY_PROVIDER, it.provider.wireValue)
                putBoolean(KEY_SPEAKER_VERIFICATION_ENABLED, it.speakerVerificationEnabled)
                putBoolean(KEY_KEEP_SCREEN_AWAKE, it.keepScreenAwake)
                putBoolean(KEY_NOISE_FILTER_ENABLED, it.noiseFilterEnabled)
                putString(KEY_NOISE_SENSITIVITY, it.noiseSensitivity.value)
                putString(KEY_TECHNICAL_TERMS, it.technicalTerms.joinToString("\n"))
            }
        }
    }

    fun setAdaptiveTurnControl(enabled: Boolean) { preferences.edit { putBoolean("adaptive_turn_control", enabled) } }

    fun setSpeakerphoneEnabled(enabled: Boolean): VoiceSettings = load().copy(
        speakerphoneEnabled = enabled,
    ).also {
        preferences.edit { putBoolean(KEY_SPEAKERPHONE_ENABLED, enabled) }
    }

    fun setSilentMode(enabled: Boolean): VoiceSettings = load().copy(silentMode = enabled).also {
        preferences.edit { putBoolean("silent_mode", enabled) }
    }

    fun setSilentModelTier(tier: BrainModelTier): VoiceSettings = load().copy(silentModelTier = tier).also {
        preferences.edit { putString("silent_model_tier", tier.wireValue) }
    }

    fun setProvider(provider: VoiceProviderPreference): VoiceSettings = load().copy(
        provider = provider,
    ).also {
        preferences.edit { putString(KEY_PROVIDER, provider.wireValue) }
    }

    fun setInteractionMode(mode: VoiceInteractionMode): VoiceSettings = load().copy(interactionMode = mode).also {
        preferences.edit { putString("interaction_mode", mode.value) }
    }

    fun setBoundaryLearningEnabled(enabled: Boolean) {
        preferences.edit(commit = true) { putBoolean("boundary_learning_enabled", enabled) }
    }

    companion object {
        const val DEFAULT_SEND_KEYWORD = "发送"
        const val DEFAULT_PLAYBACK_RATE = 1.25f
        const val DEFAULT_SPEAKER_VERIFICATION_ENABLED = true
        const val DEFAULT_SPEAKERPHONE_ENABLED = true
        const val DEFAULT_KEEP_SCREEN_AWAKE = true
        const val DEFAULT_NOISE_FILTER_ENABLED = true
        const val MAX_KEYWORD_LENGTH = 12
        const val MAX_TECHNICAL_TERMS = 10
        const val MAX_TECHNICAL_TERM_LENGTH = 40
        val DEFAULT_TECHNICAL_TERMS = listOf(
            "TermBridge",
            "Herdr",
            "Codex",
            "Claude Code",
            "Token",
            "LLM",
            "Skill",
            "Agent",
            "PTY",
            "Cloudflare",
        )
        val PLAYBACK_RATES = listOf(1f, 1.25f, 1.5f, 2f, 2.5f, 3f)
        private const val PREFERENCES = "voice_preferences"
        private const val KEY_SEND_KEYWORD = "send_keyword"
        private const val KEY_PLAYBACK_RATE = "playback_rate"
        private const val KEY_PROVIDER = "provider"
        private const val KEY_SPEAKER_VERIFICATION_ENABLED = "speaker_verification_enabled"
        private const val KEY_SPEAKERPHONE_ENABLED = "speakerphone_enabled"
        private const val KEY_KEEP_SCREEN_AWAKE = "keep_screen_awake"
        private const val KEY_NOISE_FILTER_ENABLED = "noise_filter_enabled"
        private const val KEY_NOISE_SENSITIVITY = "noise_sensitivity"
        private const val KEY_TECHNICAL_TERMS = "technical_terms"
        private val surroundingPunctuation = Regex("^[\\s，。！？、,.!?；;：:]+|[\\s，。！？、,.!?；;：:]+$")
        private val termSeparators = Regex("[,，;；\\n\\r]+")

        fun cleanKeyword(value: String?): String = value
            ?.replace(surroundingPunctuation, "")
            ?.trim()
            .orEmpty()

        fun normalizeKeyword(value: String?): String =
            cleanKeyword(value).takeIf(String::isNotEmpty) ?: DEFAULT_SEND_KEYWORD

        fun normalizePlaybackRate(value: Float): Float =
            PLAYBACK_RATES.minBy { candidate -> kotlin.math.abs(candidate - value) }

        fun normalizeTechnicalTerms(value: String?): List<String> {
            val seen = mutableSetOf<String>()
            return value.orEmpty()
                .split(termSeparators)
                .map { it.trim().replace(Regex("\\s+"), " ") }
                .filter(String::isNotEmpty)
                .filter { seen.add(it.lowercase(Locale.ROOT)) }
        }
    }
}
