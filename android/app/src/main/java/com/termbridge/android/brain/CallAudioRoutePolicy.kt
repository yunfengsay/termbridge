package com.termbridge.android.brain

internal enum class CallAudioRouteKind {
    BLE_HEADSET,
    BLUETOOTH_SCO,
    HEARING_AID,
    WIRED_HEADSET,
    USB_HEADSET,
    USB_DEVICE,
    BUILTIN_SPEAKER,
    BUILTIN_EARPIECE,
    OTHER,
}

/** Pure route policy. Android device discovery and route application stay in [CallAudioSession]. */
internal object CallAudioRoutePolicy {
    private val externalPriority = listOf(
        CallAudioRouteKind.BLE_HEADSET,
        CallAudioRouteKind.BLUETOOTH_SCO,
        CallAudioRouteKind.HEARING_AID,
        CallAudioRouteKind.WIRED_HEADSET,
        CallAudioRouteKind.USB_HEADSET,
        CallAudioRouteKind.USB_DEVICE,
    )

    fun select(
        available: List<CallAudioRouteKind>,
        current: CallAudioRouteKind?,
        forceSpeaker: Boolean,
        speakerFallback: Boolean,
    ): CallAudioRouteKind? {
        if (forceSpeaker) {
            return CallAudioRouteKind.BUILTIN_SPEAKER.takeIf(available::contains)
        }
        if (current in externalPriority && current in available) return current
        externalPriority.firstOrNull(available::contains)?.let { return it }
        val preferredLocal = if (speakerFallback) {
            CallAudioRouteKind.BUILTIN_SPEAKER
        } else {
            CallAudioRouteKind.BUILTIN_EARPIECE
        }
        if (preferredLocal in available) return preferredLocal
        return listOf(
            CallAudioRouteKind.BUILTIN_SPEAKER,
            CallAudioRouteKind.BUILTIN_EARPIECE,
        ).firstOrNull(available::contains)
    }
}
