package com.termbridge.android.brain

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import android.view.inputmethod.EditorInfo
import android.widget.ArrayAdapter
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.view.isVisible
import com.google.android.material.button.MaterialButton
import com.google.android.material.snackbar.Snackbar
import com.termbridge.android.R
import com.termbridge.android.databinding.ActivityVoiceProfileBinding
import com.termbridge.android.peer.PhonePhotoAccessScope
import com.termbridge.android.peer.PhonePhotoPermissions
import com.termbridge.android.protocol.VoiceUsageInfo
import com.termbridge.android.ui.applyWindowInsets
import java.util.concurrent.Executors

class VoiceProfileActivity : AppCompatActivity() {
    private lateinit var binding: ActivityVoiceProfileBinding
    private lateinit var store: VoiceProfileStore
    private lateinit var settingsStore: VoiceSettingsStore
    private var selectedPlaybackRate = VoiceSettingsStore.DEFAULT_PLAYBACK_RATE
    private var selectedProvider = VoiceProviderPreference.AUTO
    private var selectedInteractionMode = VoiceInteractionMode.CONTINUOUS
    private var selectedNoiseSensitivity = VoiceNoiseSensitivity.CONSERVATIVE
    private val modelExecutor = Executors.newSingleThreadExecutor()
    private val samples = mutableListOf<FloatArray>()
    private var models: OnDeviceVoiceModels? = null
    private var capture: OnDeviceVoiceCapture? = null
    private var destroyed = false
    private val permission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) startSample() else Snackbar.make(
            binding.root,
            R.string.brain_microphone_permission,
            Snackbar.LENGTH_LONG,
        ).show()
    }
    private val permissionCenter = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
        renderPermissionCenter()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityVoiceProfileBinding.inflate(layoutInflater)
        setContentView(binding.root)
        applyWindowInsets(binding.root)
        store = VoiceProfileStore(this)
        settingsStore = VoiceSettingsStore(this)
        binding.toolbar.setNavigationOnClickListener { finish() }
        binding.recordButton.setOnClickListener(::requestSample)
        binding.deleteButton.setOnClickListener {
            store.clear()
            samples.clear()
            render()
        }
        setupPermissionCenter()
        binding.backgroundTrafficSaver.isChecked = com.termbridge.android.data.TrafficSettings.enabled(this)
        binding.backgroundTrafficSaver.setOnCheckedChangeListener { _, enabled ->
            com.termbridge.android.data.TrafficSettings.setEnabled(this, enabled)
        }
        binding.brainToolsButton.setOnClickListener {
            startActivity(Intent(this, BrainToolsActivity::class.java))
        }
        setupVoiceSettings()
        fun renderSilentTier() {
            binding.silentModelTierButton.setText(if (settingsStore.load().silentModelTier ==
                com.termbridge.android.protocol.BrainModelTier.DEEP) R.string.silent_tier_deep else R.string.silent_tier_advanced)
        }
        renderSilentTier()
        binding.silentModelTierButton.setOnClickListener {
            val tiers = com.termbridge.android.protocol.BrainModelTier.entries
            com.google.android.material.dialog.MaterialAlertDialogBuilder(this)
                .setSingleChoiceItems(arrayOf(getString(R.string.silent_tier_advanced), getString(R.string.silent_tier_deep)),
                    tiers.indexOf(settingsStore.load().silentModelTier)) { dialog, which ->
                    settingsStore.setSilentModelTier(tiers[which]); renderSilentTier(); dialog.dismiss()
                }.show()
        }
        renderVoiceUsage()
        render()
    }

    override fun onResume() {
        super.onResume()
        if (::binding.isInitialized) renderPermissionCenter()
    }

    override fun onStop() {
        capture?.stop()
        capture = null
        binding.voiceLevel.clear()
        binding.progress.isVisible = false
        binding.recordButton.isEnabled = true
        super.onStop()
    }

    override fun onDestroy() {
        destroyed = true
        capture?.stop()
        capture = null
        modelExecutor.execute {
            models?.close()
            models = null
        }
        modelExecutor.shutdown()
        super.onDestroy()
    }

    private fun requestSample(@Suppress("UNUSED_PARAMETER") view: android.view.View) {
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            permission.launch(Manifest.permission.RECORD_AUDIO)
        } else {
            startSample()
        }
    }

    private fun startSample() {
        if (capture != null) return
        binding.progress.isVisible = true
        binding.recordButton.isEnabled = false
        binding.status.setText(R.string.voice_profile_loading)
        modelExecutor.execute {
            val loaded = runCatching { models ?: OnDeviceVoiceModels(applicationContext).also { models = it } }
            runOnUiThread {
                if (destroyed) return@runOnUiThread
                loaded.onSuccess(::recordSample).onFailure {
                    binding.progress.isVisible = false
                    binding.recordButton.isEnabled = true
                    binding.status.text = it.message ?: getString(R.string.brain_voice_unavailable)
                }
            }
        }
    }

    private fun recordSample(loadedModels: OnDeviceVoiceModels) {
        binding.progress.isVisible = false
        binding.status.setText(R.string.voice_profile_listening)
        val next = OnDeviceVoiceCapture(
            models = loadedModels,
            profile = null,
            enrollment = true,
            listener = object : OnDeviceVoiceCapture.Listener {
                override fun onLevel(level: Float) = runOnUiThread { binding.voiceLevel.setLevel(level) }
                override fun onSpeechDetected() = runOnUiThread {
                    binding.status.setText(R.string.voice_profile_recording)
                }
                override fun onAuthorizedSpeechDetected() = Unit
                override fun onAuthorizedAudio(pcm16: ByteArray) = Unit
                override fun onUtteranceCommitted() = Unit
                override fun onVoiceRejected() = finishSample(null)
                override fun onEnrollmentSample(embedding: FloatArray) = finishSample(embedding)
                override fun onError(message: String) = runOnUiThread {
                    capture = null
                    binding.recordButton.isEnabled = true
                    binding.status.text = message
                }
            },
        )
        capture = next
        if (!next.start()) capture = null
    }

    private fun finishSample(embedding: FloatArray?) = runOnUiThread {
        capture = null
        binding.voiceLevel.clear()
        binding.recordButton.isEnabled = true
        if (embedding == null) {
            binding.status.setText(R.string.voice_profile_too_short)
            return@runOnUiThread
        }
        samples += embedding
        if (samples.size >= PROMPTS.size) {
            runCatching { store.save(VoiceEmbedding.average(samples)) }
                .onSuccess {
                    samples.clear()
                    binding.status.setText(R.string.voice_profile_ready)
                }
                .onFailure {
                    samples.removeAt(samples.lastIndex)
                    binding.status.text = it.message ?: getString(R.string.voice_profile_save_failed)
                }
        }
        render()
    }

    private fun render() {
        val enrolled = store.exists()
        binding.status.setText(
            when {
                samples.isNotEmpty() -> R.string.voice_profile_in_progress
                enrolled -> R.string.voice_profile_ready
                else -> R.string.voice_profile_not_set
            },
        )
        binding.prompt.text = PROMPTS[samples.size.coerceAtMost(PROMPTS.lastIndex)]
        binding.recordButton.text = if (enrolled && samples.isEmpty()) {
            getString(R.string.voice_profile_replace)
        } else {
            getString(R.string.voice_profile_record_number, samples.size + 1, PROMPTS.size)
        }
        binding.deleteButton.isVisible = enrolled
    }

    private fun setupVoiceSettings() {
        val settings = settingsStore.load()
        selectedPlaybackRate = settings.playbackRate
        selectedProvider = settings.provider
        selectedInteractionMode = settings.interactionMode
        binding.wakeWordInput.setText(settings.wakeWord)
        binding.stopWordsInput.setText(settings.stopWords.joinToString(", "))
        binding.boundaryLearningSwitch.isChecked = settings.boundaryLearningEnabled
        binding.boundaryLearningSwitch.setOnCheckedChangeListener { _, enabled ->
            settingsStore.setBoundaryLearningEnabled(enabled)
            modelExecutor.execute { runCatching { com.termbridge.android.brain.personalization.PersonalControlStore(applicationContext).consent(enabled) } }
        }
        binding.boundarySamplesButton.setText(R.string.voice_learning_title)
        binding.boundarySamplesButton.setOnClickListener {
            startActivity(Intent(this, com.termbridge.android.brain.personalization.PersonalControlActivity::class.java))
        }
        binding.boundaryModelButton.setText(if (BoundaryModelFiles(this).isReady()) R.string.voice_boundary_model_ready else R.string.voice_boundary_model_download)
        binding.boundaryModelButton.setOnClickListener {
            binding.boundaryModelButton.isEnabled = false
            modelExecutor.execute {
                var lastPercent = -1
                val result = runCatching { BoundaryModelFiles(applicationContext).install { percent ->
                    if (percent != lastPercent) {
                        lastPercent = percent
                        runOnUiThread { if (!destroyed) binding.boundaryModelButton.text = "$percent%" }
                    }
                } }
                runOnUiThread {
                    if (!destroyed) {
                        binding.boundaryModelButton.isEnabled = true
                        binding.boundaryModelButton.setText(if (result.isSuccess) R.string.voice_boundary_model_ready else R.string.voice_boundary_model_download)
                        result.exceptionOrNull()?.let { Snackbar.make(binding.root, it.message.orEmpty(), Snackbar.LENGTH_LONG).show() }
                    }
                }
            }
        }
        val modeLabels = VoiceInteractionMode.entries.map(::interactionModeLabel)
        binding.voiceInteractionInput.setAdapter(ArrayAdapter(this, android.R.layout.simple_dropdown_item_1line, modeLabels))
        binding.voiceInteractionInput.setText(interactionModeLabel(selectedInteractionMode), false)
        binding.voiceInteractionInput.setOnItemClickListener { _, _, position, _ ->
            selectedInteractionMode = VoiceInteractionMode.entries[position]
        }
        selectedNoiseSensitivity = settings.noiseSensitivity
        binding.speakerVerificationSwitch.isChecked = settings.speakerVerificationEnabled
        binding.keepScreenAwakeSwitch.isChecked = settings.keepScreenAwake
        binding.noiseFilterSwitch.isChecked = settings.noiseFilterEnabled
        binding.sendKeywordInput.setText(settings.sendKeyword)
        binding.technicalTermsInput.setText(settings.technicalTerms.joinToString(", "))
        val labels = VoiceSettingsStore.PLAYBACK_RATES.map(::playbackRateLabel)
        binding.playbackRateInput.setAdapter(
            ArrayAdapter(this, android.R.layout.simple_dropdown_item_1line, labels),
        )
        binding.playbackRateInput.setText(playbackRateLabel(selectedPlaybackRate), false)
        binding.playbackRateInput.setOnItemClickListener { _, _, position, _ ->
            selectedPlaybackRate = VoiceSettingsStore.PLAYBACK_RATES[position]
        }
        val providerLabels = VoiceProviderPreference.entries.map(::voiceProviderLabel)
        binding.voiceProviderInput.setAdapter(
            ArrayAdapter(this, android.R.layout.simple_dropdown_item_1line, providerLabels),
        )
        binding.voiceProviderInput.setText(voiceProviderLabel(selectedProvider), false)
        binding.voiceProviderInput.setOnItemClickListener { _, _, position, _ ->
            selectedProvider = VoiceProviderPreference.entries[position]
        }
        val noiseLabels = VoiceNoiseSensitivity.entries.map(::noiseSensitivityLabel)
        binding.noiseSensitivityInput.setAdapter(
            ArrayAdapter(this, android.R.layout.simple_dropdown_item_1line, noiseLabels),
        )
        binding.noiseSensitivityInput.setText(noiseSensitivityLabel(selectedNoiseSensitivity), false)
        binding.noiseSensitivityInput.setOnItemClickListener { _, _, position, _ ->
            selectedNoiseSensitivity = VoiceNoiseSensitivity.entries[position]
        }
        binding.saveSettingsButton.setOnClickListener { saveVoiceSettings() }
        binding.sendKeywordInput.setOnEditorActionListener { _, actionId, _ ->
            if (actionId == EditorInfo.IME_ACTION_DONE) {
                saveVoiceSettings()
                true
            } else {
                false
            }
        }
    }

    private fun setupPermissionCenter() {
        bindRuntimePermission(
            binding.microphonePermissionButton,
            R.string.permission_microphone,
            arrayOf(Manifest.permission.RECORD_AUDIO),
        )
        binding.notificationPermissionButton.setOnClickListener {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
                !hasPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS))) {
                permissionCenter.launch(arrayOf(Manifest.permission.POST_NOTIFICATIONS))
            } else {
                openSystemSettings(
                    Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                        .putExtra(Settings.EXTRA_APP_PACKAGE, packageName),
                )
            }
        }
        bindRuntimePermission(
            binding.calendarPermissionButton,
            R.string.permission_calendar,
            arrayOf(Manifest.permission.READ_CALENDAR, Manifest.permission.WRITE_CALENDAR),
        )
        binding.photoLibraryPermissionButton.setOnClickListener {
            if (PhonePhotoPermissions.scope(this) == PhonePhotoAccessScope.NONE) {
                permissionCenter.launch(PhonePhotoPermissions.requested())
            } else {
                openAppPermissionSettings()
            }
        }
        bindRuntimePermission(
            binding.cameraPermissionButton,
            R.string.permission_camera,
            arrayOf(Manifest.permission.CAMERA),
        )
        bindRuntimePermission(binding.nearbyPermissionButton, R.string.permission_nearby, nearbyPermissions())
        binding.overlayPermissionButton.setOnClickListener {
            openSystemSettings(
                Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:$packageName")),
            )
        }
        binding.installPermissionButton.setOnClickListener {
            val intent = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:$packageName"))
            } else {
                Intent(Settings.ACTION_SECURITY_SETTINGS)
            }
            openSystemSettings(intent)
        }
        binding.batteryPermissionButton.setOnClickListener {
            val power = getSystemService(PowerManager::class.java)
            val granted = power.isIgnoringBatteryOptimizations(packageName)
            val intent = if (granted) {
                Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)
            } else {
                Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:$packageName"))
            }
            openSystemSettings(intent)
        }
        renderPermissionCenter()
    }

    private fun bindRuntimePermission(button: MaterialButton, title: Int, permissions: Array<String>) {
        button.setOnClickListener {
            val granted = permissions.filter {
                ContextCompat.checkSelfPermission(this, it) == PackageManager.PERMISSION_GRANTED
            }
            when {
                granted.size == permissions.size -> openAppPermissionSettings()
                // Some OEM upgrades can leave one permission in a dangerous
                // group granted and its companion denied while the system UI
                // still reports the whole group as allowed. Re-requesting the
                // group then returns immediately. Open the authoritative app
                // permission screen so the user can revoke/regrant the group.
                granted.isNotEmpty() -> openAppPermissionSettings()
                else -> permissionCenter.launch(permissions)
            }
        }
    }

    private fun renderPermissionCenter() {
        renderPermission(binding.microphonePermissionButton, R.string.permission_microphone,
            hasPermissions(arrayOf(Manifest.permission.RECORD_AUDIO)))
        val notificationsGranted = NotificationManagerCompat.from(this).areNotificationsEnabled() &&
            (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
                hasPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS)))
        renderPermission(binding.notificationPermissionButton, R.string.permission_notifications, notificationsGranted)
        renderPermission(binding.calendarPermissionButton, R.string.permission_calendar,
            hasPermissions(arrayOf(Manifest.permission.READ_CALENDAR, Manifest.permission.WRITE_CALENDAR)))
        val photoScope = PhonePhotoPermissions.scope(this)
        binding.photoLibraryPermissionButton.text = getString(
            R.string.permission_capability_format,
            getString(R.string.permission_photos),
            getString(when (photoScope) {
                PhonePhotoAccessScope.FULL -> R.string.permission_status_granted
                PhonePhotoAccessScope.SELECTED -> R.string.permission_status_selected
                PhonePhotoAccessScope.NONE -> R.string.permission_status_missing
            }),
        )
        renderPermission(binding.cameraPermissionButton, R.string.permission_camera,
            hasPermissions(arrayOf(Manifest.permission.CAMERA)))
        renderPermission(binding.nearbyPermissionButton, R.string.permission_nearby,
            hasPermissions(nearbyPermissions()))
        renderPermission(binding.overlayPermissionButton, R.string.permission_overlay, Settings.canDrawOverlays(this))
        val installGranted = Build.VERSION.SDK_INT < Build.VERSION_CODES.O || packageManager.canRequestPackageInstalls()
        renderPermission(binding.installPermissionButton, R.string.permission_install, installGranted)
        val power = getSystemService(PowerManager::class.java)
        renderPermission(binding.batteryPermissionButton, R.string.permission_battery,
            power.isIgnoringBatteryOptimizations(packageName))
    }

    private fun renderPermission(button: MaterialButton, title: Int, granted: Boolean) {
        button.text = getString(
            R.string.permission_capability_format,
            getString(title),
            getString(if (granted) R.string.permission_status_granted else R.string.permission_status_missing),
        )
    }

    private fun hasPermissions(permissions: Array<String>): Boolean = permissions.all {
        ContextCompat.checkSelfPermission(this, it) == PackageManager.PERMISSION_GRANTED
    }

    private fun nearbyPermissions(): Array<String> = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        arrayOf(Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.BLUETOOTH_CONNECT)
    } else {
        arrayOf(Manifest.permission.ACCESS_FINE_LOCATION)
    }

    private fun openAppPermissionSettings() {
        openSystemSettings(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName")))
    }

    private fun openSystemSettings(intent: Intent) {
        runCatching { startActivity(intent) }.onFailure {
            if (intent.action != Settings.ACTION_APPLICATION_DETAILS_SETTINGS) {
                runCatching {
                    startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName")))
                }
            }
        }
    }

    private fun saveVoiceSettings() {
        val keyword = binding.sendKeywordInput.text?.toString().orEmpty()
        val technicalTerms = binding.technicalTermsInput.text?.toString().orEmpty()
        val wakeWord = binding.wakeWordInput.text?.toString().orEmpty()
        val validWake = runCatching {
            val tokens = assets.open("${OnDeviceWakeWord.DIR}/tokens.txt").bufferedReader().useLines { lines ->
                lines.map { it.substringBefore(' ') }.toSet()
            }
            OnDeviceWakeWord.encode(wakeWord, tokens)
        }
        if (validWake.isFailure) {
            binding.wakeWordLayout.error = validWake.exceptionOrNull()?.message
            return
        }
        binding.wakeWordLayout.error = null
        val stopWords = runCatching { VoiceStopWords.parse(binding.stopWordsInput.text?.toString().orEmpty()) }
        if (stopWords.isFailure) {
            binding.stopWordsLayout.error = stopWords.exceptionOrNull()?.message
            return
        }
        binding.stopWordsLayout.error = null
        runCatching {
            settingsStore.save(
                keyword,
                selectedPlaybackRate,
                selectedProvider,
                binding.speakerVerificationSwitch.isChecked,
                technicalTerms,
                binding.keepScreenAwakeSwitch.isChecked,
                binding.noiseFilterSwitch.isChecked,
                selectedNoiseSensitivity,
                selectedInteractionMode,
                wakeWord,
                stopWords.getOrThrow(),
            )
        }
            .onSuccess {
                binding.sendKeywordLayout.error = null
                binding.technicalTermsLayout.error = null
                binding.sendKeywordInput.setText(it.sendKeyword)
                binding.technicalTermsInput.setText(it.technicalTerms.joinToString(", "))
                Snackbar.make(binding.root, R.string.voice_settings_saved, Snackbar.LENGTH_SHORT).show()
            }
            .onFailure {
                val termsInvalid = technicalTerms.isNotBlank() && runCatching {
                    val normalized = VoiceSettingsStore.normalizeTechnicalTerms(technicalTerms)
                    require(normalized.size <= VoiceSettingsStore.MAX_TECHNICAL_TERMS)
                    require(normalized.all { term -> term.length <= VoiceSettingsStore.MAX_TECHNICAL_TERM_LENGTH })
                }.isFailure
                binding.sendKeywordLayout.error = if (termsInvalid) null else it.message
                binding.technicalTermsLayout.error = if (termsInvalid) it.message else null
            }
    }

    private fun playbackRateLabel(rate: Float): String =
        getString(R.string.voice_playback_rate_value, rate.toString().removeSuffix(".0"))

    private fun showBoundarySamples() {
        val learning = VoiceBoundaryLearningStore(this)
        val entries = learning.entries().take(100).map(::orgJson)
        val dialog = com.google.android.material.dialog.MaterialAlertDialogBuilder(this)
            .setTitle(R.string.voice_boundary_samples)
            .setNegativeButton(android.R.string.cancel, null)
            .setNeutralButton(R.string.voice_boundary_clear) { _, _ ->
                com.google.android.material.dialog.MaterialAlertDialogBuilder(this)
                    .setMessage(R.string.voice_boundary_clear_confirm)
                    .setNegativeButton(android.R.string.cancel, null)
                    .setPositiveButton(android.R.string.ok) { _, _ ->
                        learning.disableAndClear()
                        binding.boundaryLearningSwitch.isChecked = false
                    }.show()
            }
        if (entries.isEmpty()) dialog.setMessage(R.string.voice_boundary_samples_empty)
        else dialog.setItems(entries.map { it.optString("label") + " · " + it.optString("currentUser").take(48) }.toTypedArray()) { _, index ->
            val example = entries[index]
            com.google.android.material.dialog.MaterialAlertDialogBuilder(this)
                .setTitle(example.optString("label"))
                .setMessage(example.toString(2))
                .setNegativeButton(android.R.string.cancel, null)
                .setPositiveButton(R.string.voice_boundary_delete) { _, _ ->
                    learning.delete(example.getString("id"))
                    showBoundarySamples()
                }.show()
        }
        dialog.show()
    }

    private fun orgJson(value: String) = org.json.JSONObject(value)

    private fun interactionModeLabel(mode: VoiceInteractionMode): String = getString(
        if (mode == VoiceInteractionMode.CONTINUOUS) R.string.voice_mode_continuous else R.string.voice_mode_wake_word,
    )

    private fun voiceProviderLabel(provider: VoiceProviderPreference): String = getString(
        when (provider) {
            VoiceProviderPreference.AUTO -> R.string.voice_provider_auto
            VoiceProviderPreference.BAILIAN -> R.string.voice_provider_bailian
            VoiceProviderPreference.VOLCENGINE -> R.string.voice_provider_volcengine
        },
    )

    private fun noiseSensitivityLabel(sensitivity: VoiceNoiseSensitivity): String = getString(
        when (sensitivity) {
            VoiceNoiseSensitivity.CONSERVATIVE -> R.string.voice_noise_sensitivity_conservative
            VoiceNoiseSensitivity.BALANCED -> R.string.voice_noise_sensitivity_balanced
            VoiceNoiseSensitivity.SENSITIVE -> R.string.voice_noise_sensitivity_sensitive
        },
    )

    private fun renderVoiceUsage() {
        val count = intent.getIntExtra(EXTRA_USAGE_RESPONSES, 0)
        val cost = intent.getDoubleExtra(EXTRA_USAGE_COST_CNY, 0.0)
        val inputMinutes = intent.getDoubleExtra(EXTRA_USAGE_INPUT_SECONDS, 0.0) / 60.0
        val outputMinutes = intent.getDoubleExtra(EXTRA_USAGE_OUTPUT_SECONDS, 0.0) / 60.0
        binding.voiceUsageAmount.text = getString(R.string.voice_usage_amount, cost)
        binding.voiceUsageDetail.text = getString(
            R.string.voice_usage_detail,
            count,
            inputMinutes,
            outputMinutes,
        )
    }

    companion object {
        private val PROMPTS = listOf(
            "TermBridge 只听我的声音",
            "请把正在工作的任务汇总给我",
            "准备好了，现在发送",
        )

        private const val EXTRA_USAGE_RESPONSES = "voice_usage_responses"
        private const val EXTRA_USAGE_COST_CNY = "voice_usage_cost_cny"
        private const val EXTRA_USAGE_INPUT_SECONDS = "voice_usage_input_seconds"
        private const val EXTRA_USAGE_OUTPUT_SECONDS = "voice_usage_output_seconds"

        fun intent(context: Context, usage: VoiceUsageInfo? = null): Intent =
            Intent(context, VoiceProfileActivity::class.java).apply {
                usage?.let {
                    putExtra(EXTRA_USAGE_RESPONSES, it.responseCount)
                    putExtra(EXTRA_USAGE_COST_CNY, it.estimatedCostCny)
                    putExtra(EXTRA_USAGE_INPUT_SECONDS, it.inputAudioSeconds)
                    putExtra(EXTRA_USAGE_OUTPUT_SECONDS, it.outputAudioSeconds)
                }
            }
    }
}
