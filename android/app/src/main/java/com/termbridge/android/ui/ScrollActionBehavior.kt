package com.termbridge.android.ui

import android.view.View
import androidx.interpolator.view.animation.FastOutSlowInInterpolator
import androidx.recyclerview.widget.RecyclerView

/** Transforms only: no layout changes, timer loops, or snapshot-driven visibility toggles. */
class ScrollActionBehavior(private val action: View) : RecyclerView.OnScrollListener() {
    private val progress = ScrollActionProgress(112f * action.resources.displayMetrics.density)
    private val easing = FastOutSlowInInterpolator()
    private var target = 1f

    override fun onScrolled(recyclerView: RecyclerView, dx: Int, dy: Int) {
        if (dy == 0 || recyclerView.scrollState == RecyclerView.SCROLL_STATE_IDLE) return
        target = progress.scroll(dy, atTop = !recyclerView.canScrollVertically(-1))
        if (target > 0f) action.visibility = View.VISIBLE
        action.isClickable = target > 0.25f
        action.importantForAccessibility = if (target > 0.25f) View.IMPORTANT_FOR_ACCESSIBILITY_AUTO
            else View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
        action.animate().cancel()
        action.animate().scaleX(target).scaleY(target).alpha(target)
            .setInterpolator(easing).setDuration(140L)
            .withEndAction { if (target == 0f) action.visibility = View.INVISIBLE }
            .start()
    }
}
