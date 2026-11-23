package com.termbridge.android.ui

/** Scroll distance, not list updates or item count, controls the floating action. */
class ScrollActionProgress(private val travel: Float) {
    init { require(travel > 0f) }
    var visibleFraction = 1f
        private set

    fun scroll(dy: Int, atTop: Boolean): Float {
        visibleFraction = if (atTop) 1f else (visibleFraction - dy / travel).coerceIn(0f, 1f)
        return visibleFraction
    }
}
