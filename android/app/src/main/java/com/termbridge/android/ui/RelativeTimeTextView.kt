package com.termbridge.android.ui

import android.content.Context
import android.text.format.DateUtils
import android.util.AttributeSet
import androidx.appcompat.widget.AppCompatTextView

/** Keeps a visible completion age human-readable without rebinding the whole list. */
class RelativeTimeTextView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
    defStyleAttr: Int = 0,
) : AppCompatTextView(context, attrs, defStyleAttr) {
    private var timestamp: Long? = null
    private val refresh = object : Runnable {
        override fun run() {
            updateText()
            postDelayed(this, REFRESH_INTERVAL_MS)
        }
    }

    fun setTimestamp(value: Long?) {
        timestamp = value
        updateText()
        removeCallbacks(refresh)
        if (value != null && isAttachedToWindow) postDelayed(refresh, REFRESH_INTERVAL_MS)
    }

    override fun onAttachedToWindow() {
        super.onAttachedToWindow()
        if (timestamp != null) {
            updateText()
            removeCallbacks(refresh)
            postDelayed(refresh, REFRESH_INTERVAL_MS)
        }
    }

    override fun onDetachedFromWindow() {
        removeCallbacks(refresh)
        super.onDetachedFromWindow()
    }

    private fun updateText() {
        val value = timestamp
        text = if (value == null) {
            ""
        } else {
            DateUtils.getRelativeTimeSpanString(
                value,
                System.currentTimeMillis(),
                DateUtils.MINUTE_IN_MILLIS,
                DateUtils.FORMAT_ABBREV_RELATIVE,
            )
        }
    }

    private companion object {
        const val REFRESH_INTERVAL_MS = 60_000L
    }
}
