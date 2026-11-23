package com.termbridge.android

import android.app.Activity
import android.app.Application
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import com.termbridge.android.brain.VoiceAppVisibility
import com.termbridge.android.brain.VoiceCallUiState
import com.termbridge.android.brain.VoiceCallOwnership
import com.termbridge.android.brain.VoiceOverlayPolicy

/** Tracks whether any TermBridge Activity is visible without coupling the call to one screen. */
class TermbridgeApplication : Application(), Application.ActivityLifecycleCallbacks {
    private val handler = Handler(Looper.getMainLooper())
    private var startedActivities = 0
    private var backgroundGeneration = 0
    private var visibilityCheckScheduled = false
    // Independent of the overlay Service: if that Service disappears, it cannot
    // be responsible for policing its own absence.
    private val verifyCallVisibility = object : Runnable {
        override fun run() {
            visibilityCheckScheduled = false
            val state = VoiceCallUiState.current()
            if (!state.active) return
            if (!VoiceOverlayPolicy.canRetain(true,
                    VoiceAppVisibility.isForeground() && state.surfaceVisible, state.overlayVisible)) {
                VoiceCallOwnership.shared.stopActive("no_visible_call_surface")
            }
            if (VoiceCallUiState.current().active) scheduleVisibilityCheck()
        }
    }

    override fun onCreate() {
        super.onCreate()
        registerActivityLifecycleCallbacks(this)
        VoiceCallUiState.addListener {
            if (!it.active) {
                handler.removeCallbacks(verifyCallVisibility)
                visibilityCheckScheduled = false
            } else scheduleVisibilityCheck()
        }
    }

    private fun scheduleVisibilityCheck() {
        if (visibilityCheckScheduled) return
        visibilityCheckScheduled = true
        handler.postDelayed(verifyCallVisibility, 500)
    }

    override fun onActivityStarted(activity: Activity) {
        startedActivities += 1
        backgroundGeneration += 1
        VoiceAppVisibility.setForeground(true)
    }

    override fun onActivityStopped(activity: Activity) {
        startedActivities = (startedActivities - 1).coerceAtLeast(0)
        if (startedActivities != 0) return
        val generation = ++backgroundGeneration
        handler.postDelayed({
            if (startedActivities == 0 && generation == backgroundGeneration) {
                VoiceAppVisibility.setForeground(false)
            }
        }, BACKGROUND_DEBOUNCE_MS)
    }

    override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) = Unit
    override fun onActivityResumed(activity: Activity) = Unit
    override fun onActivityPaused(activity: Activity) = Unit
    override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) = Unit
    override fun onActivityDestroyed(activity: Activity) = Unit

    private companion object {
        const val BACKGROUND_DEBOUNCE_MS = 300L
    }
}
