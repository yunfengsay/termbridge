package com.termbridge.android.watch

import android.annotation.SuppressLint
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothProfile
import android.bluetooth.BluetoothStatusCodes
import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.Looper
import java.util.ArrayDeque
import java.util.concurrent.atomic.AtomicInteger

/** One bonded, encrypted GATT connection to the S3A3 watch. */
@SuppressLint("MissingPermission")
class WatchBleClient(
    context: Context,
    private val device: BluetoothDevice,
    private val listener: Listener,
) {
    interface Listener {
        fun onWatchReady(client: WatchBleClient)
        fun onWatchMessage(message: WatchLinkMessage)
        fun onWatchDisconnected()
        fun onWatchError(message: String)
    }

    private val appContext = context.applicationContext
    private val incoming = WatchLinkCodec.Reassembler()
    private val outgoing = ArrayDeque<PendingWrite>()
    private val handler = Handler(Looper.getMainLooper())
    private var gatt: BluetoothGatt? = null
    private var phoneToWatch: BluetoothGattCharacteristic? = null
    private var negotiatedMtu = 23
    private var writing = false
    private var voiceStreaming = false
    private val sequence = AtomicInteger(1)
    private val voicePriorityRefresh = object : Runnable {
        override fun run() {
            if (!voiceStreaming) return
            gatt?.requestConnectionPriority(BluetoothGatt.CONNECTION_PRIORITY_HIGH)
            handler.postDelayed(this, VOICE_PRIORITY_REFRESH_MS)
        }
    }
    private val connectionTimeout = Runnable {
        gatt?.let {
            listener.onWatchError("Bluetooth connection timed out")
            closeGatt(it)
        }
    }

    val negotiatedAttMtu: Int
        get() = negotiatedMtu

    fun connect() {
        if (gatt != null) return
        gatt = runCatching {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                device.connectGatt(appContext, false, callback, BluetoothDevice.TRANSPORT_LE)
            } else {
                device.connectGatt(appContext, false, callback)
            }
        }.getOrNull()
        if (gatt == null) {
            listener.onWatchError("Could not start Bluetooth connection")
            listener.onWatchDisconnected()
            return
        }
        handler.postDelayed(connectionTimeout, CONNECTION_TIMEOUT_MS)
    }

    fun disconnect() {
        val active = gatt
        gatt = null
        handler.removeCallbacks(connectionTimeout)
        voiceStreaming = false
        handler.removeCallbacks(voicePriorityRefresh)
        synchronized(outgoing) {
            outgoing.clear()
            writing = false
        }
        active?.disconnect()
        active?.close()
    }

    /** Use a low-latency BLE interval only while raw watch voice PCM is active. */
    fun setVoiceStreaming(enabled: Boolean) {
        val active = gatt ?: return
        voiceStreaming = enabled
        handler.removeCallbacks(voicePriorityRefresh)
        if (enabled && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            active.setPreferredPhy(
                BluetoothDevice.PHY_LE_2M_MASK,
                BluetoothDevice.PHY_LE_2M_MASK,
                BluetoothDevice.PHY_OPTION_NO_PREFERRED,
            )
        }
        active.requestConnectionPriority(
            if (enabled) BluetoothGatt.CONNECTION_PRIORITY_HIGH
            else BluetoothGatt.CONNECTION_PRIORITY_BALANCED,
        )
        if (enabled) handler.postDelayed(voicePriorityRefresh, VOICE_PRIORITY_REFRESH_MS)
    }

    fun send(type: Int, payload: ByteArray = byteArrayOf(), streaming: Boolean = false): Boolean {
        if (phoneToWatch == null) return false
        val mtuPayload = (negotiatedMtu - 3).coerceAtLeast(20)
        val id = sequence.getAndUpdate { (it + 1) and 0xffff }
        val fragments = WatchLinkCodec.fragment(type, id, payload, mtuPayload)
        synchronized(outgoing) {
            if (outgoing.size + fragments.size > MAX_QUEUED_FRAGMENTS) return false
            fragments.forEach { outgoing += PendingWrite(it, streaming) }
        }
        writeNext()
        return true
    }

    private val callback = object : BluetoothGattCallback() {
        override fun onConnectionStateChange(gatt: BluetoothGatt, status: Int, newState: Int) {
            if (status != BluetoothGatt.GATT_SUCCESS) {
                listener.onWatchError("Bluetooth connection failed ($status)")
                closeGatt(gatt)
                return
            }
            when (newState) {
                BluetoothProfile.STATE_CONNECTED -> {
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                        gatt.setPreferredPhy(
                            BluetoothDevice.PHY_LE_2M_MASK,
                            BluetoothDevice.PHY_LE_2M_MASK,
                            BluetoothDevice.PHY_OPTION_NO_PREFERRED,
                        )
                    }
                    gatt.requestConnectionPriority(BluetoothGatt.CONNECTION_PRIORITY_HIGH)
                    val requested = gatt.requestMtu(WatchBleContract.PREFERRED_MTU)
                    if (!requested) gatt.discoverServices()
                }
                BluetoothProfile.STATE_DISCONNECTED -> closeGatt(gatt)
            }
        }

        override fun onMtuChanged(gatt: BluetoothGatt, mtu: Int, status: Int) {
            if (status == BluetoothGatt.GATT_SUCCESS) negotiatedMtu = mtu
            gatt.discoverServices()
        }

        override fun onServicesDiscovered(gatt: BluetoothGatt, status: Int) {
            if (status != BluetoothGatt.GATT_SUCCESS) {
                listener.onWatchError("Could not read watch services")
                closeGatt(gatt)
                return
            }
            val service = gatt.getService(WatchBleContract.SERVICE_UUID)
            val watchToPhone = service?.getCharacteristic(WatchBleContract.WATCH_TO_PHONE_UUID)
            phoneToWatch = service?.getCharacteristic(WatchBleContract.PHONE_TO_WATCH_UUID)
            if (watchToPhone == null || phoneToWatch == null) {
                listener.onWatchError("This is not a compatible TermBridge Watch")
                closeGatt(gatt)
                return
            }
            if (!gatt.setCharacteristicNotification(watchToPhone, true)) {
                listener.onWatchError("Could not enable watch messages")
                closeGatt(gatt)
                return
            }
            val descriptor = watchToPhone.getDescriptor(WatchBleContract.CLIENT_CONFIGURATION_UUID)
            if (descriptor == null) {
                listener.onWatchError("Watch notification descriptor is missing")
                closeGatt(gatt)
                return
            }
            writeDescriptor(gatt, descriptor, BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE)
        }

        @Deprecated("Used below Android 13")
        override fun onCharacteristicChanged(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic) {
            receive(characteristic.value ?: return)
        }

        override fun onCharacteristicChanged(
            gatt: BluetoothGatt,
            characteristic: BluetoothGattCharacteristic,
            value: ByteArray,
        ) {
            receive(value)
        }

        override fun onDescriptorWrite(
            gatt: BluetoothGatt,
            descriptor: BluetoothGattDescriptor,
            status: Int,
        ) {
            descriptorWritten(status)
        }

        @Deprecated("Used below Android 13")
        override fun onCharacteristicWrite(
            gatt: BluetoothGatt,
            characteristic: BluetoothGattCharacteristic,
            status: Int,
        ) {
            writeFinished(status)
        }
    }

    private fun descriptorWritten(status: Int) {
        val active = gatt ?: return
        if (status == BluetoothGatt.GATT_SUCCESS) {
            handler.removeCallbacks(connectionTimeout)
            active.requestConnectionPriority(BluetoothGatt.CONNECTION_PRIORITY_BALANCED)
            listener.onWatchReady(this)
        } else {
            listener.onWatchError("Could not subscribe to watch messages ($status)")
            closeGatt(active)
        }
    }

    private fun receive(bytes: ByteArray) {
        runCatching { incoming.accept(bytes) }
            .onSuccess { message -> if (message != null) listener.onWatchMessage(message) }
            .onFailure {
                incoming.reset()
                listener.onWatchError(it.message ?: "Invalid watch message")
            }
    }

    private fun writeNext() {
        val activeGatt = gatt ?: return
        val characteristic = phoneToWatch ?: return
        val pending = synchronized(outgoing) {
            if (writing || outgoing.isEmpty()) {
                null
            } else {
                outgoing.removeFirst().also { writing = true }
            }
        } ?: return
        val writeType = if (pending.streaming) {
            BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE
        } else {
            BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT
        }
        val accepted = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            activeGatt.writeCharacteristic(characteristic, pending.bytes, writeType) == BluetoothStatusCodes.SUCCESS
        } else {
            @Suppress("DEPRECATION")
            run {
                characteristic.writeType = writeType
                characteristic.value = pending.bytes
                activeGatt.writeCharacteristic(characteristic)
            }
        }
        if (!accepted) {
            synchronized(outgoing) { writing = false }
            listener.onWatchError("Bluetooth write queue stopped")
            closeGatt(activeGatt)
        }
    }

    private fun writeFinished(status: Int) {
        synchronized(outgoing) { writing = false }
        if (status != BluetoothGatt.GATT_SUCCESS) {
            listener.onWatchError("Bluetooth write failed ($status)")
            gatt?.let(::closeGatt)
            return
        }
        writeNext()
    }

    private fun closeGatt(closed: BluetoothGatt) {
        if (gatt !== closed) return
        gatt = null
        handler.removeCallbacks(connectionTimeout)
        voiceStreaming = false
        handler.removeCallbacks(voicePriorityRefresh)
        phoneToWatch = null
        synchronized(outgoing) {
            outgoing.clear()
            writing = false
        }
        runCatching { closed.disconnect() }
        runCatching { closed.close() }
        listener.onWatchDisconnected()
    }

    private fun writeDescriptor(gatt: BluetoothGatt, descriptor: BluetoothGattDescriptor, bytes: ByteArray) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            gatt.writeDescriptor(descriptor, bytes)
        } else {
            @Suppress("DEPRECATION")
            run {
                descriptor.value = bytes
                gatt.writeDescriptor(descriptor)
            }
        }
    }

    private data class PendingWrite(val bytes: ByteArray, val streaming: Boolean)

    private companion object {
        const val CONNECTION_TIMEOUT_MS = 20_000L
        const val MAX_QUEUED_FRAGMENTS = 512
        const val VOICE_PRIORITY_REFRESH_MS = 1_500L
    }
}
