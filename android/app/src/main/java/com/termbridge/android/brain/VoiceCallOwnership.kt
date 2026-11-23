package com.termbridge.android.brain

/** Main-thread call lease. Screens may multiply; microphone/playback ownership must not. */
internal class VoiceCallOwnership {
    private data class Owner(val token: Any, val stop: (String) -> Unit)
    private var owner: Owner? = null

    fun acquire(token: Any, stop: (String) -> Unit) {
        if (owner?.token === token) return
        owner?.stop?.invoke("replaced")
        owner = Owner(token, stop)
    }

    fun release(token: Any): Boolean {
        if (owner?.token !== token) return false
        owner = null
        return true
    }

    fun owns(token: Any): Boolean = owner?.token === token

    fun stopActive(reason: String) {
        owner?.stop?.invoke(reason)
    }

    companion object {
        val shared = VoiceCallOwnership()
    }
}
