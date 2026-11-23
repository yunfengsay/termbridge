package com.termbridge.android.brain

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import androidx.annotation.RequiresApi
import java.util.concurrent.Executor

/** Enables the Android voice-processing path (AEC/NS) only while a Call is active. */
class CallAudioSession(
    context: Context,
    private val onRouteChanged: () -> Unit = {},
) {
    private val audioManager = context.applicationContext.getSystemService(AudioManager::class.java)
    private val focusListener = AudioManager.OnAudioFocusChangeListener { }
    private val mainHandler = Handler(Looper.getMainLooper())
    private val mainExecutor = Executor(mainHandler::post)
    private val deviceCallback = object : AudioDeviceCallback() {
        override fun onAudioDevicesAdded(addedDevices: Array<out AudioDeviceInfo>) = refreshAutoRoute()
        override fun onAudioDevicesRemoved(removedDevices: Array<out AudioDeviceInfo>) = refreshAutoRoute()
    }
    private val communicationDeviceListener = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        AudioManager.OnCommunicationDeviceChangedListener { device ->
            Log.i(TAG, "communication route changed type=${device?.type ?: AudioDeviceInfo.TYPE_UNKNOWN}")
            onRouteChanged()
        }
    } else {
        null
    }
    private var previousMode: Int? = null
    private var previousSpeakerphoneOn: Boolean? = null
    private var focusRequest: AudioFocusRequest? = null
    private var focusHeld = false
    private var speakerFallback = true
    private var forceSpeaker = false
    private var callbacksRegistered = false

    fun start(speakerphoneEnabled: Boolean, acquireFocus: Boolean = true) {
        speakerFallback = speakerphoneEnabled
        forceSpeaker = false
        if (previousMode != null) {
            setStandby(!acquireFocus)
            ensureRoute()
            return
        }
        previousMode = audioManager.mode
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
            @Suppress("DEPRECATION")
            previousSpeakerphoneOn = audioManager.isSpeakerphoneOn
        }
        if (acquireFocus) requestFocus()
        audioManager.mode = AudioManager.MODE_IN_COMMUNICATION
        registerRouteCallbacks()
        ensureRoute()
    }

    /** Keep the headset microphone route, but do not hold exclusive media focus while waiting. */
    fun setStandby(standby: Boolean) {
        if (previousMode == null) return
        if (standby) abandonFocus() else requestFocus()
    }

    /** Speaker ON is an explicit in-call override. OFF returns to automatic external-device routing. */
    fun setSpeakerphoneEnabled(enabled: Boolean): Boolean {
        speakerFallback = enabled
        forceSpeaker = enabled
        return ensureRoute()
    }

    fun ensureRoute(): Boolean = runCatching { applyRoute() }
        .onFailure { Log.w(TAG, "could not apply communication route", it) }
        .getOrDefault(false)

    fun isSpeakerphoneEnabled(): Boolean = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        audioManager.communicationDevice?.type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER
    } else {
        @Suppress("DEPRECATION")
        audioManager.isSpeakerphoneOn
    }

    fun stop() {
        val mode = previousMode ?: return
        previousMode = null
        unregisterRouteCallbacks()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            runCatching { audioManager.clearCommunicationDevice() }
        } else {
            @Suppress("DEPRECATION")
            runCatching { audioManager.stopBluetoothSco() }
            previousSpeakerphoneOn?.let { previous ->
                @Suppress("DEPRECATION")
                runCatching { audioManager.isSpeakerphoneOn = previous }
            }
        }
        previousSpeakerphoneOn = null
        forceSpeaker = false
        runCatching { audioManager.mode = mode }
        abandonFocus()
    }

    private fun applyRoute(): Boolean {
        val result = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            applyModernRoute()
        } else {
            applyLegacyRoute()
        }
        onRouteChanged()
        return result
    }

    @RequiresApi(Build.VERSION_CODES.S)
    private fun applyModernRoute(): Boolean {
        val devices = audioManager.availableCommunicationDevices
        val current = audioManager.communicationDevice
        val selectedKind = CallAudioRoutePolicy.select(
            available = devices.map { it.callRouteKind() },
            current = current?.callRouteKind(),
            forceSpeaker = forceSpeaker,
            speakerFallback = speakerFallback,
        )
        val target = selectedKind?.let { kind -> devices.firstOrNull { it.callRouteKind() == kind } }
        val accepted = when {
            target == null -> {
                audioManager.clearCommunicationDevice()
                true
            }
            current?.id == target.id -> true
            else -> audioManager.setCommunicationDevice(target)
        }
        Log.i(
            TAG,
            "route request current=${current?.callRouteKind()} selected=$selectedKind " +
                "available=${devices.map { it.callRouteKind() }} accepted=$accepted",
        )
        return accepted
    }

    @Suppress("DEPRECATION")
    private fun applyLegacyRoute(): Boolean {
        val devices = audioManager.getDevices(AudioManager.GET_DEVICES_OUTPUTS)
        val current = when {
            audioManager.isBluetoothScoOn -> CallAudioRouteKind.BLUETOOTH_SCO
            audioManager.isSpeakerphoneOn -> CallAudioRouteKind.BUILTIN_SPEAKER
            else -> null
        }
        val selected = CallAudioRoutePolicy.select(
            available = devices.map { it.callRouteKind() },
            current = current,
            forceSpeaker = forceSpeaker,
            speakerFallback = speakerFallback,
        )
        when (selected) {
            CallAudioRouteKind.BLUETOOTH_SCO -> {
                audioManager.isSpeakerphoneOn = false
                audioManager.startBluetoothSco()
                audioManager.isBluetoothScoOn = true
            }
            CallAudioRouteKind.BUILTIN_SPEAKER -> {
                audioManager.stopBluetoothSco()
                audioManager.isBluetoothScoOn = false
                audioManager.isSpeakerphoneOn = true
            }
            else -> {
                audioManager.stopBluetoothSco()
                audioManager.isBluetoothScoOn = false
                audioManager.isSpeakerphoneOn = false
            }
        }
        Log.i(TAG, "legacy route request current=$current selected=$selected")
        return selected != null
    }

    private fun refreshAutoRoute() {
        if (previousMode == null) return
        mainHandler.post { if (previousMode != null) ensureRoute() }
    }

    private fun registerRouteCallbacks() {
        if (callbacksRegistered) return
        callbacksRegistered = true
        audioManager.registerAudioDeviceCallback(deviceCallback, mainHandler)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            communicationDeviceListener?.let {
                audioManager.addOnCommunicationDeviceChangedListener(mainExecutor, it)
            }
        }
    }

    private fun unregisterRouteCallbacks() {
        if (!callbacksRegistered) return
        callbacksRegistered = false
        runCatching { audioManager.unregisterAudioDeviceCallback(deviceCallback) }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            communicationDeviceListener?.let {
                runCatching { audioManager.removeOnCommunicationDeviceChangedListener(it) }
            }
        }
    }

    private fun requestFocus() {
        if (focusHeld) return
        focusHeld = true
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val request = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_EXCLUSIVE)
                .setAudioAttributes(
                    AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                        .build(),
                )
                .setOnAudioFocusChangeListener(focusListener)
                .build()
            focusRequest = request
            audioManager.requestAudioFocus(request)
        } else {
            @Suppress("DEPRECATION")
            audioManager.requestAudioFocus(
                focusListener,
                AudioManager.STREAM_VOICE_CALL,
                AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_EXCLUSIVE,
            )
        }
    }

    private fun abandonFocus() {
        if (!focusHeld) return
        focusHeld = false
        val request = focusRequest
        focusRequest = null
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && request != null) {
            audioManager.abandonAudioFocusRequest(request)
        } else {
            @Suppress("DEPRECATION")
            audioManager.abandonAudioFocus(focusListener)
        }
    }

    private fun AudioDeviceInfo.callRouteKind(): CallAudioRouteKind = when (type) {
        AudioDeviceInfo.TYPE_BLE_HEADSET -> CallAudioRouteKind.BLE_HEADSET
        AudioDeviceInfo.TYPE_BLUETOOTH_SCO -> CallAudioRouteKind.BLUETOOTH_SCO
        AudioDeviceInfo.TYPE_HEARING_AID -> CallAudioRouteKind.HEARING_AID
        AudioDeviceInfo.TYPE_WIRED_HEADSET -> CallAudioRouteKind.WIRED_HEADSET
        AudioDeviceInfo.TYPE_USB_HEADSET -> CallAudioRouteKind.USB_HEADSET
        AudioDeviceInfo.TYPE_USB_DEVICE -> CallAudioRouteKind.USB_DEVICE
        AudioDeviceInfo.TYPE_BUILTIN_SPEAKER -> CallAudioRouteKind.BUILTIN_SPEAKER
        AudioDeviceInfo.TYPE_BUILTIN_EARPIECE -> CallAudioRouteKind.BUILTIN_EARPIECE
        else -> CallAudioRouteKind.OTHER
    }

    private companion object {
        const val TAG = "TermbridgeAudio"
    }
}
