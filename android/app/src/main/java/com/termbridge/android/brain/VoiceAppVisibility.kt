package com.termbridge.android.brain

import java.util.concurrent.CopyOnWriteArraySet

/** Process-wide app visibility used only to decide when the system call orb is needed. */
object VoiceAppVisibility {
    private val listeners = CopyOnWriteArraySet<(Boolean) -> Unit>()
    @Volatile private var foreground = false

    fun isForeground(): Boolean = foreground

    fun addListener(listener: (Boolean) -> Unit) {
        listeners += listener
        listener(foreground)
    }

    fun removeListener(listener: (Boolean) -> Unit) {
        listeners -= listener
    }

    fun setForeground(value: Boolean) {
        if (!value) VoiceCallUiState.clearActivitySurfaces()
        if (foreground == value) return
        foreground = value
        listeners.forEach { it(value) }
    }
}

internal object VoiceOverlayPolicy {
    fun shouldShow(callActive: Boolean, appForeground: Boolean, overlayAllowed: Boolean): Boolean =
        callActive && !appForeground && overlayAllowed

    fun canRetain(callActive: Boolean, surfaceVisible: Boolean, overlayVisible: Boolean): Boolean =
        callActive && (surfaceVisible || overlayVisible)
}
