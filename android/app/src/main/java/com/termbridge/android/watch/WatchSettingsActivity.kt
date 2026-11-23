package com.termbridge.android.watch

import android.Manifest
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothManager
import android.companion.AssociationInfo
import android.companion.AssociationRequest
import android.companion.BluetoothDeviceFilter
import android.companion.CompanionDeviceManager
import android.content.BroadcastReceiver
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.IntentSender
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.format.DateUtils
import android.provider.Settings
import androidx.activity.result.IntentSenderRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.annotation.RequiresApi
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.view.isVisible
import com.google.android.material.snackbar.Snackbar
import com.termbridge.android.R
import com.termbridge.android.data.SettingsStore
import com.termbridge.android.databinding.ActivityWatchSettingsBinding
import com.termbridge.android.notifications.AgentMonitorService
import com.termbridge.android.ui.applyWindowInsets
import java.util.regex.Pattern

class WatchSettingsActivity : AppCompatActivity() {
    private lateinit var binding: ActivityWatchSettingsBinding
    private var pendingBondAddress: String? = null
    private val handler = Handler(Looper.getMainLooper())
    private var stateReceiverRegistered = false
    private val refreshTelemetry = object : Runnable {
        override fun run() {
            render()
            handler.postDelayed(this, TELEMETRY_REFRESH_MS)
        }
    }

    private val stateReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            if (intent.action == WatchGatewayService.ACTION_WATCH_STATE_CHANGED) render()
        }
    }

    private val bondReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            if (intent.action != BluetoothDevice.ACTION_BOND_STATE_CHANGED) return
            @Suppress("DEPRECATION")
            val device = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                intent.getParcelableExtra(BluetoothDevice.EXTRA_DEVICE, BluetoothDevice::class.java)
            } else {
                intent.getParcelableExtra(BluetoothDevice.EXTRA_DEVICE)
            } ?: return
            if (!device.address.equals(pendingBondAddress, ignoreCase = true)) return
            when (intent.getIntExtra(BluetoothDevice.EXTRA_BOND_STATE, BluetoothDevice.BOND_NONE)) {
                BluetoothDevice.BOND_BONDED -> completePairing(device)
                BluetoothDevice.BOND_NONE -> {
                    pendingBondAddress = null
                    Snackbar.make(binding.root, R.string.watch_pair_failed, Snackbar.LENGTH_LONG).show()
                }
            }
        }
    }

    private val permissionRequest = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { grants ->
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && grants.values.all { it }) beginAssociation()
        else Snackbar.make(binding.root, R.string.watch_permission_required, Snackbar.LENGTH_LONG).show()
    }

    private val dailyPermissionRequest = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { grants ->
        WatchGatewayService.sync(this)
        Snackbar.make(
            binding.root,
            if (grants.values.all { it }) R.string.watch_daily_features_enabled else R.string.watch_daily_features_partial,
            Snackbar.LENGTH_LONG,
        ).show()
    }

    private val chooser = registerForActivityResult(ActivityResultContracts.StartIntentSenderForResult()) { result ->
        if (result.resultCode != RESULT_OK) return@registerForActivityResult
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return@registerForActivityResult
        val device = associatedDevice(result.data)
        if (device == null) {
            Snackbar.make(binding.root, R.string.watch_pair_failed, Snackbar.LENGTH_LONG).show()
            return@registerForActivityResult
        }
        @Suppress("MissingPermission")
        if (device.bondState == BluetoothDevice.BOND_BONDED) {
            completePairing(device)
        } else {
            pendingBondAddress = device.address
            if (!device.createBond()) {
                pendingBondAddress = null
                Snackbar.make(binding.root, R.string.watch_pair_failed, Snackbar.LENGTH_LONG).show()
            } else {
                Snackbar.make(binding.root, R.string.watch_pair_started, Snackbar.LENGTH_LONG).show()
            }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityWatchSettingsBinding.inflate(layoutInflater)
        setContentView(binding.root)
        ContextCompat.registerReceiver(
            this,
            bondReceiver,
            IntentFilter(BluetoothDevice.ACTION_BOND_STATE_CHANGED),
            // Bluetooth runs outside the system UID on current Android releases.
            // The action itself is a protected system broadcast, so exporting this
            // narrowly filtered dynamic receiver lets Bluetooth deliver it without
            // allowing third-party apps to spoof the bond result.
            ContextCompat.RECEIVER_EXPORTED,
        )
        applyWindowInsets(binding.root)
        binding.toolbar.setNavigationOnClickListener { finish() }
        binding.pairWatch.setOnClickListener { pairWatch() }
        binding.forgetWatch.setOnClickListener { forgetWatch() }
        binding.copyZeppPairingCode.setOnClickListener {
            val token = ZeppBridgeTokenStore.getOrCreate(this)
            getSystemService(ClipboardManager::class.java).setPrimaryClip(
                ClipData.newPlainText(getString(R.string.watch_zepp_pairing_code), token),
            )
            AgentMonitorService.start(this)
            Snackbar.make(binding.root, R.string.watch_zepp_pairing_code_copied, Snackbar.LENGTH_LONG).show()
        }
        binding.enableDailyFeatures.setOnClickListener {
            dailyPermissionRequest.launch(
                arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.READ_CALENDAR),
            )
        }
        binding.notifyAttention.setOnCheckedChangeListener { _, checked ->
            updateZeppPreferences { it.copy(notifyAttention = checked) }
        }
        binding.notifyFailure.setOnCheckedChangeListener { _, checked ->
            updateZeppPreferences { it.copy(notifyFailure = checked) }
        }
        binding.notifyCompletion.setOnCheckedChangeListener { _, checked ->
            updateZeppPreferences { it.copy(notifyCompletion = checked) }
        }
        binding.confirmWatchVoice.setOnCheckedChangeListener { _, checked ->
            updateZeppPreferences { it.copy(confirmVoiceBeforeSend = checked) }
        }
        binding.openNotificationSettings.setOnClickListener {
            startActivity(
                Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                    .putExtra(Settings.EXTRA_APP_PACKAGE, packageName)
                    .setData(Uri.parse("package:$packageName")),
            )
        }
        binding.transport.addOnButtonCheckedListener { _, checkedId, isChecked ->
            if (!isChecked) return@addOnButtonCheckedListener
            val transport = when (checkedId) {
                R.id.transportBluetooth -> WatchTransport.BLUETOOTH
                R.id.transportWifi -> WatchTransport.WIFI
                else -> WatchTransport.AUTO
            }
            WatchSettingsStore.save(this, WatchSettingsStore.load(this).copy(transport = transport))
            WatchGatewayService.sync(this)
            renderLinkDescription(transport)
        }
        render()
    }

    override fun onResume() {
        super.onResume()
        render()
        handler.removeCallbacks(refreshTelemetry)
        handler.postDelayed(refreshTelemetry, TELEMETRY_REFRESH_MS)
    }

    override fun onStart() {
        super.onStart()
        ContextCompat.registerReceiver(
            this,
            stateReceiver,
            IntentFilter(WatchGatewayService.ACTION_WATCH_STATE_CHANGED),
            ContextCompat.RECEIVER_NOT_EXPORTED,
        )
        stateReceiverRegistered = true
    }

    override fun onStop() {
        handler.removeCallbacks(refreshTelemetry)
        if (stateReceiverRegistered) {
            unregisterReceiver(stateReceiver)
            stateReceiverRegistered = false
        }
        super.onStop()
    }

    override fun onDestroy() {
        unregisterReceiver(bondReceiver)
        super.onDestroy()
    }

    @Suppress("MissingPermission")
    private fun completePairing(device: BluetoothDevice) {
        pendingBondAddress = null
        val current = WatchSettingsStore.load(this)
        WatchSettingsStore.save(
            this,
            current.copy(
                deviceAddress = device.address,
                deviceName = device.name.orEmpty().ifBlank { WatchBleContract.ADVERTISED_NAME },
                batteryLevel = null,
                lastReportedAt = 0L,
                connected = false,
            ),
        )
        WatchGatewayService.sync(this)
        render()
        Snackbar.make(binding.root, R.string.watch_pair_complete, Snackbar.LENGTH_LONG).show()
    }

    private fun pairWatch() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            Snackbar.make(binding.root, R.string.watch_android_version_required, Snackbar.LENGTH_LONG).show()
            return
        }
        val missing = bluetoothPermissions().filter {
            ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED
        }
        if (missing.isEmpty()) beginAssociation() else permissionRequest.launch(missing.toTypedArray())
    }

    @RequiresApi(Build.VERSION_CODES.O)
    private fun beginAssociation() {
        val request = AssociationRequest.Builder()
            .setSingleDevice(false)
            .addDeviceFilter(
                BluetoothDeviceFilter.Builder()
                    .setNamePattern(Pattern.compile("^${Pattern.quote(WatchBleContract.ADVERTISED_NAME)}"))
                    .build(),
            )
            .build()
        getSystemService(CompanionDeviceManager::class.java).associate(
            request,
            object : CompanionDeviceManager.Callback() {
                override fun onAssociationPending(intentSender: IntentSender) = launchChooser(intentSender)

                @Deprecated("Android 12 and earlier callback")
                override fun onDeviceFound(chooserLauncher: IntentSender) = launchChooser(chooserLauncher)

                override fun onFailure(error: CharSequence?) {
                    runOnUiThread {
                        Snackbar.make(
                            binding.root,
                            error?.toString()?.takeIf(String::isNotBlank) ?: getString(R.string.watch_pair_failed),
                            Snackbar.LENGTH_LONG,
                        ).show()
                    }
                }
            },
            Handler(Looper.getMainLooper()),
        )
    }

    private fun launchChooser(intentSender: IntentSender) {
        chooser.launch(IntentSenderRequest.Builder(intentSender).build())
    }

    @Suppress("DEPRECATION", "MissingPermission")
    @RequiresApi(Build.VERSION_CODES.O)
    private fun associatedDevice(data: Intent?): BluetoothDevice? {
        if (data == null) return null
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            data.getParcelableExtra(CompanionDeviceManager.EXTRA_DEVICE, BluetoothDevice::class.java)?.let { return it }
            val association = data.getParcelableExtra(
                CompanionDeviceManager.EXTRA_ASSOCIATION,
                AssociationInfo::class.java,
            )
            val address = association?.deviceMacAddress?.toString() ?: return null
            return getSystemService(BluetoothManager::class.java).adapter.getRemoteDevice(address)
        }
        return data.getParcelableExtra(CompanionDeviceManager.EXTRA_DEVICE)
    }

    private fun forgetWatch() {
        val watch = WatchSettingsStore.load(this)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && watch.deviceAddress.isNotBlank()) {
            disassociate(watch.deviceAddress)
        }
        WatchGatewayService.stopAndForget(this)
        render()
    }

    @Suppress("DEPRECATION")
    @RequiresApi(Build.VERSION_CODES.O)
    private fun disassociate(address: String) {
        val manager = getSystemService(CompanionDeviceManager::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            manager.myAssociations
                .filter { it.deviceMacAddress?.toString().equals(address, ignoreCase = true) }
                .forEach { manager.disassociate(it.id) }
        } else {
            runCatching { manager.disassociate(address) }
        }
    }

    private fun render() {
        val watch = WatchSettingsStore.load(this)
        val current = SettingsStore.load(this)
        binding.watchName.text = if (watch.paired) watch.deviceName else getString(R.string.watch_not_paired)
        binding.watchStatus.setText(
            when {
                !watch.paired -> R.string.watch_pair_explanation
                watch.connected -> R.string.watch_connected
                else -> R.string.watch_paired_disconnected
            },
        )
        binding.watchTelemetry.isVisible = watch.paired
        binding.watchBattery.text = watch.batteryLevel?.let { getString(R.string.watch_battery_value, it) }
            ?: getString(R.string.watch_battery_unknown)
        binding.watchLastReport.text = if (watch.lastReportedAt > 0L) {
            val relative = DateUtils.getRelativeTimeSpanString(
                watch.lastReportedAt,
                System.currentTimeMillis(),
                DateUtils.MINUTE_IN_MILLIS,
                DateUtils.FORMAT_ABBREV_RELATIVE,
            )
            getString(R.string.watch_last_report, relative)
        } else {
            getString(R.string.watch_waiting_for_report)
        }
        binding.pairWatch.setText(if (watch.paired) R.string.watch_pair_another else R.string.watch_pair)
        binding.forgetWatch.isEnabled = watch.paired
        binding.currentLink.text = getString(
            R.string.watch_current_link_value,
            current.displayName,
            current.relayUrl,
        )
        binding.zeppPairingCode.text = ZeppBridgeTokenStore.display(ZeppBridgeTokenStore.getOrCreate(this))
        val zeppPreferences = ZeppWatchPreferencesStore.load(this)
        binding.notifyAttention.isChecked = zeppPreferences.notifyAttention
        binding.notifyFailure.isChecked = zeppPreferences.notifyFailure
        binding.notifyCompletion.isChecked = zeppPreferences.notifyCompletion
        binding.confirmWatchVoice.isChecked = zeppPreferences.confirmVoiceBeforeSend
        renderZeppHub()
        binding.transport.check(
            when (watch.transport) {
                WatchTransport.AUTO -> R.id.transportAuto
                WatchTransport.BLUETOOTH -> R.id.transportBluetooth
                WatchTransport.WIFI -> R.id.transportWifi
            },
        )
        renderLinkDescription(watch.transport)
    }

    private fun renderZeppHub() {
        val snapshot = ZeppBridgeStateStore.snapshot()
        val port = ZeppBridgeRuntimeState.boundPort()
        binding.zeppBridgeStatus.setText(
            if (port > 0) R.string.watch_bridge_online else R.string.watch_bridge_offline,
        )
        binding.zeppAgentCounts.text = getString(
            R.string.watch_agent_counts,
            snapshot.agents.count { it.priority == 0 },
            snapshot.agents.count { it.priority == 1 },
            snapshot.agents.size,
        )
        val updated = if (snapshot.updatedAt > 0L) {
            DateUtils.getRelativeTimeSpanString(
                snapshot.updatedAt,
                System.currentTimeMillis(),
                DateUtils.SECOND_IN_MILLIS,
                DateUtils.FORMAT_ABBREV_RELATIVE,
            )
        } else "—"
        binding.zeppDiagnostics.text = getString(
            R.string.watch_bridge_diagnostics,
            if (snapshot.connected) snapshot.host else getString(R.string.watch_host_disconnected),
            if (port > 0) "127.0.0.1:$port" else "—",
            updated,
        )
        val activity = ZeppWatchActivityStore.load(this).take(6)
        binding.watchActivityHistory.text = if (activity.isEmpty()) {
            getString(R.string.watch_activity_empty)
        } else {
            activity.joinToString("\n\n") { item ->
                getString(
                    R.string.watch_activity_row,
                    watchActivityKind(item.kind),
                    watchActivityState(item.state),
                    item.summary.ifBlank { item.title },
                )
            }
        }
    }

    private fun updateZeppPreferences(transform: (ZeppWatchPreferences) -> ZeppWatchPreferences) {
        val current = ZeppWatchPreferencesStore.load(this)
        val updated = transform(current)
        if (updated == current) return
        ZeppWatchPreferencesStore.save(this, updated)
        AgentMonitorService.start(this)
    }

    private fun watchActivityKind(kind: String): String = when (kind) {
        "voice" -> getString(R.string.watch_activity_voice)
        "action:summarize" -> getString(R.string.watch_action_summarize)
        "action:retry" -> getString(R.string.watch_action_retry)
        "action:continue" -> getString(R.string.watch_action_continue)
        "action:stop" -> getString(R.string.watch_action_stop)
        "action:snooze" -> getString(R.string.watch_action_snooze)
        else -> getString(R.string.watch_activity_title)
    }

    private fun watchActivityState(state: String): String = when (state) {
        "done" -> getString(R.string.watch_activity_done)
        "error" -> getString(R.string.watch_activity_failed)
        else -> state
    }

    private fun renderLinkDescription(transport: WatchTransport) {
        binding.transportDetail.setText(
            when (transport) {
                WatchTransport.AUTO -> R.string.watch_transport_auto_detail
                WatchTransport.BLUETOOTH -> R.string.watch_transport_bluetooth_detail
                WatchTransport.WIFI -> R.string.watch_transport_wifi_detail
            },
        )
    }

    private fun bluetoothPermissions(): List<String> = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        listOf(Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.BLUETOOTH_CONNECT)
    } else {
        emptyList()
    }

    private companion object {
        const val TELEMETRY_REFRESH_MS = 60_000L
    }
}
