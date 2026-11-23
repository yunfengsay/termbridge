package com.termbridge.android.watch

import android.Manifest
import android.annotation.SuppressLint
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.bluetooth.BluetoothStatusCodes
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanFilter
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.ParcelUuid
import androidx.core.content.ContextCompat
import java.util.ArrayDeque
import java.util.UUID

/** Reads up to one standard heart-rate and one cycling-cadence sensor during a ride. */
class WatchFitnessSensorClient(
    private val context: Context,
    private val onReading: (heartRate: Int, cadence: Int) -> Unit,
) {
    private enum class Role { HEART_RATE, CADENCE }

    private val adapter = context.getSystemService(BluetoothManager::class.java).adapter
    private val handler = Handler(Looper.getMainLooper())
    private val gatts = mutableSetOf<BluetoothGatt>()
    private val roles = mutableMapOf<BluetoothGatt, Set<Role>>()
    private val candidateRoles = mutableMapOf<String, Set<Role>>()
    private val connectionTimeouts = mutableMapOf<BluetoothGatt, Runnable>()
    private val pendingSubscriptions = mutableMapOf<BluetoothGatt, ArrayDeque<BluetoothGattCharacteristic>>()
    private var scanning = false
    private var stopped = true
    private var heartRate = 0
    private var cadence = 0
    private var previousCranks = -1
    private var previousCrankTime = -1
    private val stopScan = Runnable { stopScanning() }

    private val scan = object : ScanCallback() {
        @SuppressLint("MissingPermission")
        override fun onScanResult(callbackType: Int, result: ScanResult) {
            if (stopped || gatts.size >= MAX_SENSOR_CONNECTIONS ||
                gatts.any { it.device.address == result.device.address }
            ) return
            val advertised = buildSet {
                val services = result.scanRecord?.serviceUuids.orEmpty().map(ParcelUuid::getUuid)
                if (HEART_RATE_SERVICE in services) add(Role.HEART_RATE)
                if (CYCLING_SERVICE in services) add(Role.CADENCE)
            }
            val reserved = roles.values.flatten().toSet() + candidateRoles.values.flatten()
            val available = advertised - reserved
            if (available.isEmpty()) return
            result.device.connectGatt(context, false, callback, BluetoothDevice.TRANSPORT_LE)?.let { gatt ->
                gatts += gatt
                candidateRoles[gatt.device.address] = available
                scheduleConnectionTimeout(gatt)
            }
        }

        override fun onScanFailed(errorCode: Int) {
            scanning = false
        }
    }

    private val callback = object : BluetoothGattCallback() {
        @SuppressLint("MissingPermission")
        override fun onConnectionStateChange(gatt: BluetoothGatt, status: Int, newState: Int) {
            when {
                status == BluetoothGatt.GATT_SUCCESS && newState == BluetoothProfile.STATE_CONNECTED -> {
                    cancelConnectionTimeout(gatt)
                    scheduleConnectionTimeout(gatt)
                    if (!gatt.discoverServices()) closeGatt(gatt, rescan = true)
                }
                newState == BluetoothProfile.STATE_DISCONNECTED || status != BluetoothGatt.GATT_SUCCESS ->
                    closeGatt(gatt, rescan = true)
            }
        }

        @SuppressLint("MissingPermission")
        override fun onServicesDiscovered(gatt: BluetoothGatt, status: Int) {
            if (status != BluetoothGatt.GATT_SUCCESS) {
                closeGatt(gatt, rescan = true)
                return
            }
            val subscriptions = ArrayDeque<BluetoothGattCharacteristic>()
            val discovered = buildSet {
                gatt.getService(HEART_RATE_SERVICE)?.getCharacteristic(HEART_RATE_MEASUREMENT)?.let {
                    add(Role.HEART_RATE)
                    subscriptions += it
                }
                gatt.getService(CYCLING_SERVICE)?.getCharacteristic(CYCLING_MEASUREMENT)?.let {
                    add(Role.CADENCE)
                    subscriptions += it
                }
            }
            if (discovered.isEmpty()) {
                closeGatt(gatt, rescan = true)
                return
            }
            roles[gatt] = discovered
            candidateRoles.remove(gatt.device.address)
            pendingSubscriptions[gatt] = subscriptions
            subscribeNext(gatt)
            if (roles.values.flatten().toSet().containsAll(Role.entries)) stopScanning()
        }

        override fun onDescriptorWrite(gatt: BluetoothGatt, descriptor: BluetoothGattDescriptor, status: Int) {
            if (status != BluetoothGatt.GATT_SUCCESS) {
                closeGatt(gatt, rescan = true)
                return
            }
            subscribeNext(gatt)
        }

        @Deprecated("Android 13 callback retained for older devices")
        override fun onCharacteristicChanged(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic) {
            decode(characteristic.uuid, characteristic.value)
        }

        override fun onCharacteristicChanged(
            gatt: BluetoothGatt,
            characteristic: BluetoothGattCharacteristic,
            value: ByteArray,
        ) = decode(characteristic.uuid, value)
    }

    fun start() {
        if (!hasPermissions()) return
        stopped = false
        ensureScanning()
    }

    @SuppressLint("MissingPermission")
    fun stop() {
        stopped = true
        handler.removeCallbacks(stopScan)
        connectionTimeouts.values.forEach(handler::removeCallbacks)
        connectionTimeouts.clear()
        stopScanning()
        gatts.toList().forEach { closeGatt(it, rescan = false) }
    }

    @SuppressLint("MissingPermission")
    private fun ensureScanning() {
        if (stopped || scanning || gatts.size >= MAX_SENSOR_CONNECTIONS || !hasPermissions()) return
        val filters = listOf(
            ScanFilter.Builder().setServiceUuid(ParcelUuid(HEART_RATE_SERVICE)).build(),
            ScanFilter.Builder().setServiceUuid(ParcelUuid(CYCLING_SERVICE)).build(),
        )
        adapter.bluetoothLeScanner?.startScan(
            filters,
            ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_BALANCED).build(),
            scan,
        ) ?: return
        scanning = true
        handler.removeCallbacks(stopScan)
        handler.postDelayed(stopScan, SCAN_WINDOW_MS)
    }

    @SuppressLint("MissingPermission")
    private fun stopScanning() {
        if (!scanning) return
        runCatching { adapter.bluetoothLeScanner?.stopScan(scan) }
        scanning = false
        handler.removeCallbacks(stopScan)
    }

    @SuppressLint("MissingPermission")
    private fun subscribeNext(gatt: BluetoothGatt) {
        val queue = pendingSubscriptions[gatt] ?: return
        while (queue.isNotEmpty()) {
            val characteristic = queue.removeFirst()
            val descriptor = characteristic.getDescriptor(CCCD) ?: run {
                closeGatt(gatt, rescan = true)
                return
            }
            if (!gatt.setCharacteristicNotification(characteristic, true)) {
                closeGatt(gatt, rescan = true)
                return
            }
            val accepted = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                gatt.writeDescriptor(descriptor, BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE) ==
                    BluetoothStatusCodes.SUCCESS
            } else {
                @Suppress("DEPRECATION")
                run {
                    descriptor.value = BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
                    gatt.writeDescriptor(descriptor)
                }
            }
            if (accepted) return
            closeGatt(gatt, rescan = true)
            return
        }
        pendingSubscriptions.remove(gatt)
        cancelConnectionTimeout(gatt)
        gatt.requestConnectionPriority(BluetoothGatt.CONNECTION_PRIORITY_BALANCED)
    }

    @SuppressLint("MissingPermission")
    private fun closeGatt(gatt: BluetoothGatt, rescan: Boolean) {
        pendingSubscriptions.remove(gatt)
        cancelConnectionTimeout(gatt)
        candidateRoles.remove(gatt.device.address)
        val removedRoles = roles.remove(gatt).orEmpty()
        gatts.remove(gatt)
        runCatching { gatt.disconnect() }
        runCatching { gatt.close() }
        if (Role.HEART_RATE in removedRoles && roles.values.none { Role.HEART_RATE in it }) heartRate = 0
        if (Role.CADENCE in removedRoles && roles.values.none { Role.CADENCE in it }) {
            cadence = 0
            previousCranks = -1
            previousCrankTime = -1
        }
        onReading(heartRate, cadence)
        if (rescan && !stopped) handler.postDelayed(::ensureScanning, RESCAN_DELAY_MS)
    }

    private fun scheduleConnectionTimeout(gatt: BluetoothGatt) {
        cancelConnectionTimeout(gatt)
        val timeout = Runnable { closeGatt(gatt, rescan = true) }
        connectionTimeouts[gatt] = timeout
        handler.postDelayed(timeout, CONNECTION_TIMEOUT_MS)
    }

    private fun cancelConnectionTimeout(gatt: BluetoothGatt) {
        connectionTimeouts.remove(gatt)?.let(handler::removeCallbacks)
    }

    private fun decode(uuid: UUID, value: ByteArray) {
        if (uuid == HEART_RATE_MEASUREMENT && value.size >= 2) {
            heartRate = if (value[0].toInt() and 1 == 0) value[1].toInt() and 0xff
            else if (value.size >= 3) u16(value, 1) else 0
        } else if (uuid == CYCLING_MEASUREMENT && value.size >= 5) {
            val flags = value[0].toInt() and 0xff
            var offset = 1
            if (flags and 1 != 0) offset += 6
            if (flags and 2 != 0 && value.size >= offset + 4) {
                val cranks = u16(value, offset)
                val crankTime = u16(value, offset + 2)
                if (previousCranks >= 0) {
                    val revolutions = (cranks - previousCranks) and 0xffff
                    val ticks = (crankTime - previousCrankTime) and 0xffff
                    if (ticks in 1..4096) cadence = (revolutions * 60 * 1024 / ticks).coerceIn(0, 300)
                }
                previousCranks = cranks
                previousCrankTime = crankTime
            }
        }
        onReading(heartRate.coerceIn(0, 300), cadence.coerceIn(0, 300))
    }

    private fun hasPermissions(): Boolean = Build.VERSION.SDK_INT < Build.VERSION_CODES.S ||
        (ContextCompat.checkSelfPermission(context, Manifest.permission.BLUETOOTH_SCAN) == PackageManager.PERMISSION_GRANTED &&
            ContextCompat.checkSelfPermission(context, Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED)

    private fun u16(value: ByteArray, offset: Int): Int =
        (value[offset].toInt() and 0xff) or ((value[offset + 1].toInt() and 0xff) shl 8)

    private companion object {
        const val MAX_SENSOR_CONNECTIONS = 2
        const val SCAN_WINDOW_MS = 20_000L
        const val RESCAN_DELAY_MS = 5_000L
        const val CONNECTION_TIMEOUT_MS = 20_000L
        val HEART_RATE_SERVICE: UUID = UUID.fromString("0000180d-0000-1000-8000-00805f9b34fb")
        val HEART_RATE_MEASUREMENT: UUID = UUID.fromString("00002a37-0000-1000-8000-00805f9b34fb")
        val CYCLING_SERVICE: UUID = UUID.fromString("00001816-0000-1000-8000-00805f9b34fb")
        val CYCLING_MEASUREMENT: UUID = UUID.fromString("00002a5b-0000-1000-8000-00805f9b34fb")
        val CCCD: UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")
    }
}
