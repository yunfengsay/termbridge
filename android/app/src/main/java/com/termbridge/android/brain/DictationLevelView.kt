package com.termbridge.android.brain

import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.util.AttributeSet
import android.view.View
import androidx.core.content.ContextCompat
import com.termbridge.android.R

/** Small microphone meter, deliberately separate from the conversation orb. */
class DictationLevelView(context: Context, attrs: AttributeSet?) : View(context, attrs) {
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = ContextCompat.getColor(context, R.color.green_dark)
        strokeCap = Paint.Cap.ROUND
    }
    private var target = 0f
    private var value = 0f
    fun setLevel(level: Float) { target = level.coerceIn(0f, 1f); invalidate() }
    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        value += (target - value) * .3f
        val step = width / 11f
        paint.strokeWidth = step * .38f
        for (i in 0..10) {
            val envelope = 1f - kotlin.math.abs(i - 5) / 7f
            val half = height * (.07f + value * .4f * envelope)
            canvas.drawLine(step * (i + .5f), height / 2f - half, step * (i + .5f), height / 2f + half, paint)
        }
        if (kotlin.math.abs(target - value) > .005f) postInvalidateOnAnimation()
    }
}
