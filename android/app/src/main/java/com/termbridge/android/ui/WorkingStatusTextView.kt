package com.termbridge.android.ui

import android.animation.ValueAnimator
import android.content.Context
import android.graphics.LinearGradient
import android.graphics.Matrix
import android.graphics.Shader
import android.os.Build
import android.util.AttributeSet
import android.view.animation.PathInterpolator
import androidx.appcompat.widget.AppCompatTextView
import androidx.core.content.ContextCompat
import com.termbridge.android.R
import kotlin.math.max

/** A lightweight, self-contained shimmer for the few rows that are actively working. */
class WorkingStatusTextView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
    defStyleAttr: Int = 0,
) : AppCompatTextView(context, attrs, defStyleAttr) {
    private val shaderMatrix = Matrix()
    private var shimmerAnimator: ValueAnimator? = null
    private var working = false

    fun setWorking(value: Boolean) {
        if (working == value) return
        working = value
        paint.isFakeBoldText = value
        if (value) startShimmer() else stopShimmer()
    }

    override fun onAttachedToWindow() {
        super.onAttachedToWindow()
        if (working) startShimmer()
    }

    override fun onDetachedFromWindow() {
        shimmerAnimator?.cancel()
        shimmerAnimator = null
        paint.shader = null
        super.onDetachedFromWindow()
    }

    override fun onSizeChanged(width: Int, height: Int, oldWidth: Int, oldHeight: Int) {
        super.onSizeChanged(width, height, oldWidth, oldHeight)
        if (working && width != oldWidth) startShimmer()
    }

    private fun startShimmer() {
        shimmerAnimator?.cancel()
        shimmerAnimator = null
        if (!isAttachedToWindow || width <= 0) {
            post { if (working) startShimmer() }
            return
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !ValueAnimator.areAnimatorsEnabled()) {
            paint.shader = null
            invalidate()
            return
        }

        val base = ContextCompat.getColor(context, R.color.green_dark)
        val highlight = ContextCompat.getColor(context, R.color.working_shimmer)
        val bandWidth = max(width * 0.62f, 28f * resources.displayMetrics.density)
        val shader = LinearGradient(
            0f,
            0f,
            bandWidth,
            0f,
            intArrayOf(base, highlight, base),
            floatArrayOf(0f, 0.52f, 1f),
            Shader.TileMode.CLAMP,
        )
        paint.shader = shader
        shimmerAnimator = ValueAnimator.ofFloat(-bandWidth, width + bandWidth).apply {
            duration = 4_950L
            repeatCount = ValueAnimator.INFINITE
            repeatMode = ValueAnimator.RESTART
            interpolator = PathInterpolator(0.35f, 0f, 0.2f, 1f)
            addUpdateListener { animator ->
                shaderMatrix.setTranslate(animator.animatedValue as Float, 0f)
                shader.setLocalMatrix(shaderMatrix)
                invalidate()
            }
            start()
        }
    }

    private fun stopShimmer() {
        shimmerAnimator?.cancel()
        shimmerAnimator = null
        paint.shader = null
        invalidate()
    }
}
