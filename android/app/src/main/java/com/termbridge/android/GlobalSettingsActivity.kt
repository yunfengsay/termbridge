package com.termbridge.android

import android.content.Intent
import android.net.Uri
import android.os.Build
import com.termbridge.android.data.SettingsStore
import com.google.android.material.button.MaterialButton
import android.os.Bundle
import android.provider.Settings
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.isVisible
import androidx.lifecycle.ViewModelProvider
import com.termbridge.android.brain.VoiceProfileActivity
import com.termbridge.android.databinding.ActivityGlobalSettingsBinding
import com.termbridge.android.peer.PhoneActionPolicyActivity
import com.termbridge.android.ui.applyWindowInsets
import com.termbridge.android.update.AppUpdateModel
import com.termbridge.android.update.UpdatePhase
import com.termbridge.android.watch.WatchSettingsActivity

/** App-wide entry point; existing feature settings retain their own state and permissions. */
class GlobalSettingsActivity : AppCompatActivity() {
    private lateinit var binding: ActivityGlobalSettingsBinding
    private lateinit var updates: AppUpdateModel
    private val connection = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) {
        if (it.resultCode == RESULT_OK) { setResult(RESULT_OK); renderProfiles() }
    }
    private val installPermission = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) {
        // Granting permission does not silently install. The user taps Install again.
        binding.updateStatus.setText(R.string.app_update_permission_return)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        setTheme(R.style.Theme_Termbridge_Connections)
        super.onCreate(savedInstanceState)
        binding = ActivityGlobalSettingsBinding.inflate(layoutInflater)
        setContentView(binding.root)
        applyWindowInsets(binding.root)
        updates = ViewModelProvider(this)[AppUpdateModel::class.java]
        binding.toolbar.setNavigationOnClickListener { finish() }
        binding.connectionSettings.setOnClickListener { connection.launch(Intent(this, ConnectionSettingsActivity::class.java)) }
        binding.addConnection.setOnClickListener {
            connection.launch(Intent(this, ConnectionSettingsActivity::class.java).putExtra(ConnectionSettingsActivity.EXTRA_NEW, true))
        }
        binding.voiceSettings.setOnClickListener {
            startActivity(VoiceProfileActivity.intent(this).apply { intent.extras?.let(::putExtras) })
        }
        binding.toolPermissions.setOnClickListener { startActivity(Intent(this, PhoneActionPolicyActivity::class.java)) }
        binding.watchSettings.setOnClickListener { startActivity(Intent(this, WatchSettingsActivity::class.java)) }
        binding.currentVersion.text = getString(R.string.app_update_current, updates.currentVersion)
        binding.checkUpdate.setOnClickListener { updates.check() }
        binding.cancelUpdate.setOnClickListener { updates.cancel() }
        binding.downloadUpdate.setOnClickListener {
            if (updates.state.value?.phase == UpdatePhase.READY) {
                if (Build.VERSION.SDK_INT >= 26 && !packageManager.canRequestPackageInstalls()) {
                    runCatching { installPermission.launch(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:$packageName"))) }
                        .onFailure { binding.updateStatus.setText(R.string.app_update_permission_return) }
                } else updates.install()
            } else updates.download()
        }
        updates.state.observe(this) { state ->
            val busy = state.phase in setOf(UpdatePhase.CHECKING, UpdatePhase.DOWNLOADING, UpdatePhase.INSTALLING)
            binding.checkUpdate.isEnabled = !busy
            binding.cancelUpdate.isVisible = state.phase == UpdatePhase.CHECKING || state.phase == UpdatePhase.DOWNLOADING
            binding.downloadUpdate.isVisible = state.phase == UpdatePhase.AVAILABLE || state.phase == UpdatePhase.READY
            binding.downloadUpdate.setText(if (state.phase == UpdatePhase.READY) R.string.app_update_install else R.string.app_update_download)
            binding.updateProgress.isVisible = busy
            binding.updateProgress.isIndeterminate = state.phase != UpdatePhase.DOWNLOADING
            binding.updateProgress.progress = state.progress
            binding.updateStatus.text = when (state.phase) {
                UpdatePhase.IDLE -> getString(R.string.app_update_hint)
                UpdatePhase.CHECKING -> getString(R.string.app_update_checking)
                UpdatePhase.CURRENT -> getString(R.string.app_update_latest)
                UpdatePhase.AVAILABLE -> getString(R.string.app_update_available, state.release!!.version,
                    state.release.versionCode, state.release.size / 1024.0 / 1024.0)
                UpdatePhase.UNSUPPORTED -> getString(R.string.app_update_unsupported, state.release!!.minSdk)
                UpdatePhase.DOWNLOADING -> getString(R.string.app_update_progress, state.progress)
                UpdatePhase.READY -> getString(R.string.app_update_ready)
                UpdatePhase.INSTALLING -> getString(R.string.app_update_installing)
                UpdatePhase.ERROR -> getString(R.string.app_update_error, state.error.orEmpty())
            }
        }
    }

    private fun renderProfiles() {
        binding.connectionProfiles.removeAllViews()
        val active = SettingsStore.load(this).profileKey
        SettingsStore.profiles(this).forEach { profile ->
            val button = MaterialButton(this, null, com.google.android.material.R.attr.materialButtonOutlinedStyle)
            button.text = "${if (profile.profileKey == active) "✓  " else ""}${profile.displayName}\n${profile.relayUrl}"
            button.isAllCaps = false
            button.gravity = android.view.Gravity.START or android.view.Gravity.CENTER_VERTICAL
            button.setOnClickListener {
                connection.launch(Intent(this, ConnectionSettingsActivity::class.java)
                    .putExtra(ConnectionSettingsActivity.EXTRA_PROFILE_KEY, profile.profileKey))
            }
            binding.connectionProfiles.addView(button)
        }
    }
    override fun onResume() { super.onResume(); if (::updates.isInitialized) updates.refreshInstaller(); renderProfiles() }
}
