package com.termbridge.android

import android.content.Intent
import android.net.Uri
import androidx.core.view.isVisible
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import com.termbridge.android.network.ConnectionCheck
import com.termbridge.android.network.LanConnection
import java.net.URI
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import androidx.appcompat.app.AppCompatActivity
import com.google.android.material.snackbar.Snackbar
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import com.termbridge.android.data.ConnectionSettings
import com.termbridge.android.data.PairingCode
import com.termbridge.android.data.SettingsStore
import com.termbridge.android.databinding.ActivityConnectionSettingsBinding
import com.termbridge.android.databinding.ViewConnectionSettingsBinding
import com.termbridge.android.ui.applyWindowInsets
import com.termbridge.android.watch.WatchSettingsActivity
import com.termbridge.android.watch.WatchSettingsStore
import com.termbridge.android.chat.SessionUi
import com.termbridge.android.chat.SessionUiSettings
import com.google.android.material.dialog.MaterialAlertDialogBuilder

/** Editing is local until Save (or an explicit successful pairing scan). */
class ConnectionSettingsActivity : AppCompatActivity() {
    private lateinit var binding: ActivityConnectionSettingsBinding
    private val form get() = binding.form
    private lateinit var current: ConnectionSettings
    private var previousKey: String? = null
    private var probing = false
    companion object {
        const val EXTRA_NEW = "new_connection"
        const val EXTRA_PROFILE_KEY = "profile_key"
    }
    private val scanner = registerForActivityResult(ScanContract()) { result ->
        val contents = result.contents ?: return@registerForActivityResult
        runCatching { PairingCode.parse(contents) }
            .onSuccess { save(it, replace = false) }
            .onFailure { error -> Snackbar.make(binding.root,
                getString(R.string.pairing_invalid, error.message ?: "invalid QR"), Snackbar.LENGTH_LONG).show() }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        setTheme(R.style.Theme_Termbridge_Connections)
        super.onCreate(savedInstanceState)
        binding = ActivityConnectionSettingsBinding.inflate(layoutInflater)
        setContentView(binding.root)
        applyWindowInsets(binding.root, includeKeyboard = true)
        binding.toolbar.setNavigationOnClickListener { finish() }
        val requested = intent.getStringExtra(EXTRA_PROFILE_KEY)
        val existing = SettingsStore.profiles(this).firstOrNull { it.profileKey == requested }
        if (requested != null && existing == null) {
            android.widget.Toast.makeText(this, R.string.connection_missing, android.widget.Toast.LENGTH_LONG).show()
            finish(); return
        }
        current = if (intent.getBooleanExtra(EXTRA_NEW, false)) ConnectionSettings("", "", "", "")
            else existing ?: SettingsStore.load(this)
        previousKey = current.takeIf { it.relayUrl.isNotBlank() && SettingsStore.isConfigured(this) }?.profileKey
        form.connectionName.setText(current.profileAlias.ifBlank { current.hostName })
        val uri = runCatching { URI(current.relayUrl) }.getOrNull()
        val direct = previousKey == null || current.isDirectConnection
        form.relayUrl.setText(if (direct) uri?.host.orEmpty() else current.relayUrl)
        form.port.setText((uri?.port?.takeIf { it > 0 } ?: 7400).toString())
        form.lanUseTls.isChecked = previousKey != null && uri?.scheme == "wss"
        form.connectionMode.check(if (direct) R.id.directMode else R.id.relayMode)
        renderMode(direct)
        form.lanUseTls.setOnCheckedChangeListener { _, _ ->
            renderMode(form.connectionMode.checkedButtonId == R.id.directMode)
        }
        form.connectionMode.addOnButtonCheckedListener { _, id, checked ->
            if (checked) {
                val text = form.relayUrl.text?.toString().orEmpty().trim()
                if (id == R.id.directMode) {
                    runCatching { URI(text) }.getOrNull()?.let { parsed ->
                        if (parsed.host != null) {
                            form.lanUseTls.isChecked = parsed.scheme == "wss"
                            form.relayUrl.setText(parsed.host); form.port.setText((parsed.port.takeIf { it > 0 } ?: 7400).toString())
                        }
                    }
                } else if (LanConnection.isUnicastIPv4(text)) {
                    runCatching { LanConnection.url(text, form.port.text.toString(), form.lanUseTls.isChecked) }.onSuccess { form.relayUrl.setText(it) }
                }
                renderMode(id == R.id.directMode)
            }
        }
        binding.deleteConnection.isVisible = previousKey != null
        binding.deleteConnection.setOnClickListener {
            MaterialAlertDialogBuilder(this).setMessage(R.string.connection_delete_confirm)
                .setNegativeButton(R.string.cancel, null).setPositiveButton(R.string.connection_delete) { _, _ ->
                    previousKey?.let { SettingsStore.remove(this, it) }; setResult(RESULT_OK); finish()
                }.show()
        }
        form.hostId.setText(current.hostId)
        form.sharedSecret.setText(current.secret)
        form.tlsFingerprint.setText(current.tlsFingerprint)
        form.scanPairing.setOnClickListener {
            scanner.launch(ScanOptions().setDesiredBarcodeFormats(ScanOptions.QR_CODE)
                .setPrompt(getString(R.string.scan_pairing_prompt)).setBeepEnabled(false).setOrientationLocked(false))
        }
        form.backgroundAccess.setOnClickListener { openBatteryOptimizationSettings() }
        form.watchSettings.setOnClickListener { startActivity(Intent(this, WatchSettingsActivity::class.java)) }
        form.sessionUi.setOnClickListener {
            val choices = arrayOf(getString(R.string.session_ui_auto), getString(R.string.agent_chat_title), getString(R.string.agent_chat_terminal))
            MaterialAlertDialogBuilder(this)
                .setTitle(R.string.session_ui_setting)
                .setSingleChoiceItems(choices, SessionUiSettings.load(this).ordinal) { dialog, which ->
                    SessionUiSettings.save(this, SessionUi.entries[which])
                    renderSessionUi()
                    dialog.dismiss()
                }
                .setNegativeButton(R.string.cancel, null).show()
        }
        renderSessionUi()
        binding.save.setOnClickListener { submit() }
        binding.testConnection.setOnClickListener { testConnection() }
    }

    private fun renderMode(direct: Boolean) {
        form.portLayout.isVisible = direct
        form.lanUseTls.isVisible = direct
        form.fingerprintLayout.isVisible = !direct || form.lanUseTls.isChecked
        form.hostLayout.isVisible = true
        form.relayLayout.hint = getString(if (direct) R.string.lan_ip else R.string.relay_url)
        form.relayUrl.hint = if (direct) "192.168.1.20" else getString(R.string.relay_hint)
        form.passwordLayout.helperText = getString(if (direct) R.string.lan_password_error else R.string.shared_secret_hint)
        form.fingerprintLayout.helperText = getString(if (direct) R.string.lan_fingerprint_hint else R.string.tls_fingerprint_hint)
        form.relayLayout.error = null
    }

    /** The form as an unsaved profile, or null after showing its first validation error. */
    private fun formCandidate(): ConnectionSettings? {
        val direct = form.connectionMode.checkedButtonId == R.id.directMode
        val url = runCatching {
            if (direct) LanConnection.url(form.relayUrl.text.toString(), form.port.text.toString(), form.lanUseTls.isChecked)
            else form.relayUrl.text.toString()
        }.getOrElse { form.relayLayout.error = it.message; return null }
        val candidate = current.copy(relayUrl = url, hostId = form.hostId.text.toString(),
            profileAlias = form.connectionName.text.toString(), secret = form.sharedSecret.text.toString(),
            tlsFingerprint = if (direct && !form.lanUseTls.isChecked) "" else form.tlsFingerprint.text.toString(), connectionEnabled = true,
            connectionMode = if (direct) com.termbridge.android.data.ConnectionMode.DIRECT else com.termbridge.android.data.ConnectionMode.RELAY,
            networkPolicy = if (direct) com.termbridge.android.protocol.HostNetworkPolicy.DIRECT else current.networkPolicy)
        candidate.validationError()?.let { form.relayLayout.error = it; return null }
        if (direct && candidate.secret.length !in 1..256) { form.relayLayout.error = getString(R.string.lan_password_error); return null }
        return candidate
    }

    /** Reports each network path, HTTP and the real login without saving the form. */
    private fun testConnection() {
        if (probing) return
        val candidate = formCandidate() ?: return
        form.relayLayout.error = null
        probing = true; binding.save.isEnabled = false; binding.testConnection.isEnabled = false
        binding.testConnection.setText(R.string.connection_test_running)
        lifecycleScope.launch {
            val report = withContext(Dispatchers.IO) { ConnectionCheck.run(applicationContext, candidate) }
            probing = false; binding.save.isEnabled = true; binding.testConnection.isEnabled = true
            binding.testConnection.setText(R.string.connection_test)
            if (isFinishing || isDestroyed) return@launch
            MaterialAlertDialogBuilder(this@ConnectionSettingsActivity).setTitle(R.string.connection_test)
                .setMessage(report.joinToString("\n")).setPositiveButton(android.R.string.ok, null).show()
        }
    }

    private fun submit() {
        if (probing) return
        val candidate = formCandidate() ?: return
        val direct = form.connectionMode.checkedButtonId == R.id.directMode
        val url = candidate.relayUrl
        if (!direct || !form.lanUseTls.isChecked || candidate.normalizedFingerprint.isNotEmpty()) { save(candidate); return }
        probing = true; binding.save.isEnabled = false
        binding.save.setText(R.string.lan_certificate_loading)
        lifecycleScope.launch {
            val result = withContext(Dispatchers.IO) {
                runCatching { val uri = URI(url); LanConnection.probe(uri.host, uri.port) }
            }
            probing = false; binding.save.isEnabled = true; binding.save.setText(R.string.save_connect)
            if (isFinishing || isDestroyed) return@launch
            result.onSuccess { pin ->
                MaterialAlertDialogBuilder(this@ConnectionSettingsActivity)
                    .setTitle(R.string.lan_certificate_title)
                    .setMessage(getString(R.string.lan_certificate_check, url, pin))
                    .setNegativeButton(R.string.cancel, null)
                    .setPositiveButton(R.string.lan_certificate_confirm) { _, _ -> save(candidate.copy(tlsFingerprint = pin)) }.show()
            }.onFailure { form.relayLayout.error = getString(R.string.lan_certificate_failed) }
        }
    }

    override fun onResume() {
        super.onResume()
        renderBackgroundAccess(form)
        renderWatchSettings(form)
    }

    private fun save(candidate: ConnectionSettings, replace: Boolean = true) {
        val error = candidate.validationError()
        form.relayLayout.error = error
        if (error != null) return
        if (replace) SettingsStore.replace(this, previousKey, candidate) else SettingsStore.save(this, candidate)
        setResult(RESULT_OK)
        finish()
    }

    private fun renderSessionUi() {
        val label = when (SessionUiSettings.load(this)) {
            SessionUi.AUTO -> R.string.session_ui_auto
            SessionUi.CHAT -> R.string.agent_chat_title
            SessionUi.TERMINAL -> R.string.agent_chat_terminal
        }
        form.sessionUi.text = getString(R.string.session_ui_value, getString(label))
    }

    private fun renderBackgroundAccess(form: ViewConnectionSettingsBinding) {
        val allowed = getSystemService(PowerManager::class.java).isIgnoringBatteryOptimizations(packageName)
        form.backgroundAccessStatus.setText(
            if (allowed) R.string.background_access_allowed else R.string.background_access_restricted,
        )
        form.backgroundAccess.setText(
            if (allowed) R.string.background_access_manage else R.string.background_access_allow,
        )
    }

    private fun renderWatchSettings(form: ViewConnectionSettingsBinding) {
        val watch = WatchSettingsStore.load(this)
        form.watchSettings.text = if (watch.paired) {
            watch.deviceName.ifBlank { getString(R.string.watch_settings_title) }
        } else {
            getString(R.string.watch_settings)
        }
        form.watchSettingsSummary.setText(
            if (watch.paired) R.string.watch_pair_detail else R.string.watch_settings_summary,
        )
    }

    private fun openBatteryOptimizationSettings() {
        val powerManager = getSystemService(PowerManager::class.java)
        val intent = if (powerManager.isIgnoringBatteryOptimizations(packageName)) {
            Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)
        } else {
            Intent(
                Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                Uri.parse("package:$packageName"),
            )
        }
        openSystemSettings(intent)
    }

    private fun openSystemSettings(intent: Intent) {
        runCatching { startActivity(intent) }
            .onFailure {
                startActivity(
                    Intent(
                        Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                        Uri.parse("package:$packageName"),
                    ),
                )
            }
    }


}
