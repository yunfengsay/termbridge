package com.termbridge.android.brain

internal class GlobalCallLaunchGate {
    private var pending = false

    fun request() {
        pending = true
    }

    fun consumeIfReady(ready: Boolean, callActive: Boolean): Boolean {
        if (!pending || !ready) return false
        pending = false
        return !callActive
    }
}
