package com.termbridge.android.ui

import android.app.Activity
import android.view.View
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import kotlin.math.max

/**
 * @param bottomInsetTarget takes the bottom inset instead of [root]
 *
 * A screen whose bottom-most view has its own background — the composer bar —
 * passes it here. The padding is applied once, to that view, so the bar's colour
 * continues into the gesture area rather than leaving a strip of the window
 * background below it. The system bars stay visible; nothing goes immersive.
 */
fun Activity.applyWindowInsets(
    root: View,
    includeKeyboard: Boolean = false,
    drawBehindSystemBars: () -> Boolean = { false },
    bottomInsetTarget: View? = null,
) {
    WindowCompat.setDecorFitsSystemWindows(window, false)
    ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
        val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
        val keyboardBottom = if (includeKeyboard) {
            insets.getInsets(WindowInsetsCompat.Type.ime()).bottom
        } else {
            0
        }
        val edgeToEdge = drawBehindSystemBars()
        val bottom = if (edgeToEdge) 0 else max(bars.bottom, keyboardBottom)
        view.setPadding(
            bars.left,
            if (edgeToEdge) 0 else bars.top,
            bars.right,
            if (bottomInsetTarget == null) bottom else 0,
        )
        // Absolute, never additive, so repeated inset passes cannot stack.
        bottomInsetTarget?.setPadding(0, 0, 0, bottom)
        insets
    }
    ViewCompat.requestApplyInsets(root)
}
