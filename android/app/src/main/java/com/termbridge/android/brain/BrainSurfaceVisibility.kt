package com.termbridge.android.brain

/** Call and text surfaces are mutually exclusive, including empty/reconnecting snapshots. */
data class BrainSurfaceVisibility(val call: Boolean, val timeline: Boolean, val empty: Boolean) {
    companion object {
        fun resolve(callActive: Boolean, hasItems: Boolean) = BrainSurfaceVisibility(
            call = callActive,
            timeline = !callActive && hasItems,
            empty = !callActive && !hasItems,
        )
    }
}
