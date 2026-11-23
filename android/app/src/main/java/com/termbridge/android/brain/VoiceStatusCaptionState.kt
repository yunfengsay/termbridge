package com.termbridge.android.brain

/** Tracks who owns the call caption so reconnects only clear connectivity text. */
internal class VoiceStatusCaptionState {
    private enum class Owner { NONE, OFFLINE, CONTENT }

    private var owner = Owner.NONE

    fun showOffline() {
        owner = Owner.OFFLINE
    }

    fun showContent() {
        owner = Owner.CONTENT
    }

    fun clearOfflineForRemoteReady(): Boolean {
        if (owner != Owner.OFFLINE) return false
        owner = Owner.NONE
        return true
    }

    fun clear() {
        owner = Owner.NONE
    }
}
