package com.termbridge.android.brain

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RadialGradient
import android.graphics.Shader
import android.graphics.SweepGradient
import android.os.Build
import android.os.SystemClock
import android.util.AttributeSet
import android.util.Log
import android.view.View
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin

/** Audio-reactive volumetric voice body for the continuous Voice Call surface. */
class VoiceLevelView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
) : View(context, attrs) {
    enum class Mode { CONNECTING, LISTENING, THINKING, SPEAKING, TOOL, WAITING_WAKE }

    private val density = resources.displayMetrics.density
    private val backgroundPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = STAGE_BACKGROUND }
    private val ambientPaint = Paint(Paint.ANTI_ALIAS_FLAG or Paint.DITHER_FLAG)
    private val haloPaint = Paint(Paint.ANTI_ALIAS_FLAG or Paint.DITHER_FLAG).apply {
        style = Paint.Style.STROKE
        strokeCap = Paint.Cap.ROUND
        strokeJoin = Paint.Join.ROUND
    }
    private val glowPaint = Paint(Paint.ANTI_ALIAS_FLAG or Paint.DITHER_FLAG).apply {
        style = Paint.Style.STROKE
        strokeCap = Paint.Cap.ROUND
        strokeJoin = Paint.Join.ROUND
    }
    private val linePaint = Paint(Paint.ANTI_ALIAS_FLAG or Paint.DITHER_FLAG).apply {
        style = Paint.Style.STROKE
        strokeCap = Paint.Cap.ROUND
        strokeJoin = Paint.Join.ROUND
    }
    private val ringPath = Path()
    private val compactClipPath = Path()
    private val shaderMatrix = Matrix()
    private val auraRenderer = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        try {
            VoiceAuraRenderer()
        } catch (error: IllegalArgumentException) {
            Log.w(TAG, "Unable to compile the Voice aura shader; using the Canvas fallback", error)
            null
        }
    } else {
        null
    }
    private val ambientBlue = softGlow(Color.rgb(24, 123, 255), 126)
    private val ambientCyan = softGlow(Color.rgb(20, 182, 210), 96)
    private val ambientViolet = softGlow(Color.rgb(133, 69, 255), 112)
    private val ambientRose = softGlow(Color.rgb(255, 62, 170), 88)
    private val rainbow = SweepGradient(
        0f,
        0f,
        intArrayOf(
            Color.rgb(64, 219, 255),
            Color.rgb(66, 124, 255),
            Color.rgb(137, 80, 255),
            Color.rgb(247, 73, 213),
            Color.rgb(255, 92, 133),
            Color.rgb(255, 181, 70),
            Color.rgb(75, 235, 178),
            Color.rgb(64, 219, 255),
        ),
        floatArrayOf(0f, 0.14f, 0.29f, 0.44f, 0.58f, 0.72f, 0.86f, 1f),
    )

    private var mode = Mode.CONNECTING
    private var targetLevel = 0f
    private var displayedLevel = 0f
    private var filteredInput = 0f
    private var previousInput = 0f
    private var targetRhythm = 0f
    private var displayedRhythm = 0f
    private var motionPhase = (SystemClock.uptimeMillis() % MOTION_PHASE_SEED_WINDOW_MS) / 1_000f
    private var lastFrameNanos = 0L
    private var compactMode = false

    init {
        setLayerType(LAYER_TYPE_HARDWARE, null)
        importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO
    }

    fun setLevel(level: Float) {
        val amplified = VoiceLevelDynamics.amplify(level)
        targetRhythm = VoiceLevelDynamics.rhythmTarget(previousInput, amplified)
        previousInput = amplified
        filteredInput = VoiceLevelDynamics.filterInput(filteredInput, amplified)
        targetLevel = filteredInput
        postInvalidateOnAnimation()
    }

    fun setMode(mode: Mode) {
        if (this.mode == mode) return
        this.mode = mode
        postInvalidateOnAnimation()
    }

    fun setCompactMode(compact: Boolean) {
        if (compactMode == compact) return
        compactMode = compact
        invalidate()
    }

    fun clear() {
        targetLevel = 0f
        displayedLevel = 0f
        filteredInput = 0f
        previousInput = 0f
        targetRhythm = 0f
        displayedRhythm = 0f
        lastFrameNanos = 0L
        mode = Mode.CONNECTING
        invalidate()
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        val restoreCount = if (compactMode) {
            val count = canvas.save()
            compactClipPath.reset()
            compactClipPath.addCircle(width / 2f, height / 2f, min(width, height) / 2f, Path.Direction.CW)
            canvas.clipPath(compactClipPath)
            count
        } else {
            -1
        }
        if (!compactMode) canvas.drawRect(0f, 0f, width.toFloat(), height.toFloat(), backgroundPaint)
        if (width == 0 || height == 0) {
            if (restoreCount >= 0) canvas.restoreToCount(restoreCount)
            return
        }

        val nowNanos = System.nanoTime()
        val elapsedMs = if (lastFrameNanos == 0L) VoiceLevelDynamics.FRAME_MS else {
            ((nowNanos - lastFrameNanos) / 1_000_000f).coerceIn(1f, VoiceLevelDynamics.MAX_FRAME_MS)
        }
        lastFrameNanos = nowNanos
        displayedLevel = VoiceLevelDynamics.animate(displayedLevel, targetLevel, elapsedMs)
        displayedRhythm = VoiceLevelDynamics.animateRhythm(displayedRhythm, targetRhythm, elapsedMs)

        val seconds = SystemClock.uptimeMillis() / 1_000f
        val centerX = width / 2f
        val centerY = height * if (compactMode) 0.5f else RING_CENTER_Y
        val baseRadius = if (compactMode) min(width, height) * 0.30f else min(width * 0.17f, height * 0.11f)
        val automaticEnergy = when (mode) {
            Mode.WAITING_WAKE -> 0.018f
            Mode.CONNECTING -> 0.05f + 0.018f * sin(seconds * 1.15f)
            Mode.LISTENING -> 0.075f + 0.025f * sin(seconds * 1.45f)
            Mode.THINKING -> 0.24f + 0.065f * sin(seconds * 1.9f)
            Mode.SPEAKING -> 0.42f + 0.15f * sin(seconds * 3.1f)
            Mode.TOOL -> 0.32f + 0.08f * sin(seconds * 2.35f)
        }
        val energy = max(displayedLevel, automaticEnergy).coerceIn(0f, 1f)

        val speed = animationSpeed()
        motionPhase += VoiceLevelDynamics.phaseAdvance(elapsedMs, speed, displayedLevel, displayedRhythm)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && auraRenderer != null) {
            auraRenderer.draw(
                canvas,
                width,
                height,
                centerY,
                baseRadius,
                energy,
                displayedRhythm,
                seconds,
                motionPhase,
                compactMode,
            )
        } else {
            drawAmbientField(canvas, seconds, energy, displayedRhythm)
            drawRainbowRings(canvas, centerX, centerY, baseRadius, energy, seconds, motionPhase)
        }

        if (restoreCount >= 0) canvas.restoreToCount(restoreCount)

        if (isShown) postInvalidateOnAnimation()
    }

    private fun drawRainbowRings(
        canvas: Canvas,
        centerX: Float,
        centerY: Float,
        baseRadius: Float,
        energy: Float,
        seconds: Float,
        phase: Float,
    ) {
        repeat(RING_COUNT) { ringIndex ->
            val progress = ringIndex / (RING_COUNT - 1f)
            val ringRadius = baseRadius * (0.69f + progress * 0.48f)
            ringPath.reset()
            repeat(PATH_SAMPLES + 1) { sample ->
                val angle = TWO_PI * sample / PATH_SAMPLES
                val deformation = VoiceRingDynamics.radialOffset(
                    angle = angle,
                    ringIndex = ringIndex,
                    seconds = phase,
                    energy = energy,
                    speed = 1f,
                )
                val breath = sin(seconds * (0.72f + ringIndex * 0.035f) + ringIndex * 0.83f) * 0.012f
                val radius = ringRadius * (1f + deformation + breath)
                val x = centerX + cos(angle) * radius
                val y = centerY + sin(angle) * radius
                if (sample == 0) ringPath.moveTo(x, y) else ringPath.lineTo(x, y)
            }
            ringPath.close()

            shaderMatrix.reset()
            shaderMatrix.setRotate(phase * 27f + ringIndex * 31f)
            shaderMatrix.postTranslate(centerX, centerY)
            rainbow.setLocalMatrix(shaderMatrix)

            haloPaint.shader = rainbow
            haloPaint.strokeWidth = density * (24f + energy * 16f) * (1.08f - progress * 0.25f)
            haloPaint.alpha = if (auraRenderer == null) {
                (14 + energy * 16).toInt()
            } else {
                (7 + energy * 8).toInt()
            }
            canvas.drawPath(ringPath, haloPaint)

            glowPaint.shader = rainbow
            glowPaint.strokeWidth = density * (7f + energy * 7f) * (1.08f - progress * 0.28f)
            glowPaint.alpha = (18 + energy * 23 + (1f - progress) * 7).toInt().coerceIn(0, 255)
            canvas.drawPath(ringPath, glowPaint)

            linePaint.shader = rainbow
            linePaint.strokeWidth = density * (0.78f + energy * 0.62f) * (1.04f - progress * 0.16f)
            linePaint.alpha = (104 + energy * 54 - progress * 16).toInt().coerceIn(0, 255)
            canvas.drawPath(ringPath, linePaint)
        }
    }

    private fun animationSpeed(): Float = when (mode) {
        Mode.WAITING_WAKE -> 0.3f
        Mode.CONNECTING -> 0.62f
        Mode.LISTENING -> 0.88f
        Mode.THINKING -> 1.18f
        Mode.SPEAKING -> 1.36f
        Mode.TOOL -> 1.26f
    }

    private fun drawAmbientField(canvas: Canvas, seconds: Float, energy: Float, rhythm: Float) {
        val longSide = max(width, height).toFloat()
        val drift = seconds * (0.19f + rhythm * 0.09f)
        drawSoftOval(
            canvas,
            ambientBlue,
            width * (0.08f + 0.11f * sin(drift * 0.61f)),
            height * (0.28f + 0.07f * cos(drift * 0.54f)),
            longSide * 0.72f,
            longSide * 0.58f,
            (46 + energy * 12f).toInt(),
        )
        drawSoftOval(
            canvas,
            ambientCyan,
            width * (0.64f + 0.15f * cos(drift * 0.47f)),
            height * (0.18f + 0.09f * sin(drift * 0.58f)),
            longSide * 0.68f,
            longSide * 0.56f,
            (30 + rhythm * 13f).toInt(),
        )
        drawSoftOval(
            canvas,
            ambientViolet,
            width * (0.93f + 0.10f * cos(drift * 0.43f)),
            height * (0.48f + 0.11f * sin(drift * 0.39f)),
            longSide * 0.75f,
            longSide * 0.61f,
            (43 + energy * 10f).toInt(),
        )
        drawSoftOval(
            canvas,
            ambientRose,
            width * (0.44f + 0.18f * sin(drift * 0.34f)),
            height * (0.88f + 0.07f * cos(drift * 0.41f)),
            longSide * 0.70f,
            longSide * 0.54f,
            (28 + rhythm * 9f).toInt(),
        )
    }

    private fun drawSoftOval(
        canvas: Canvas,
        shader: RadialGradient,
        centerX: Float,
        centerY: Float,
        radiusX: Float,
        radiusY: Float,
        alpha: Int,
    ) {
        shaderMatrix.reset()
        shaderMatrix.setScale(radiusX, radiusY)
        shaderMatrix.postTranslate(centerX, centerY)
        shader.setLocalMatrix(shaderMatrix)
        ambientPaint.shader = shader
        ambientPaint.alpha = alpha
        canvas.drawOval(
            centerX - radiusX,
            centerY - radiusY,
            centerX + radiusX,
            centerY + radiusY,
            ambientPaint,
        )
    }

    private companion object {
        const val RING_CENTER_Y = 0.40f
        const val RING_COUNT = 5
        const val PATH_SAMPLES = 192
        const val TWO_PI = (PI * 2.0).toFloat()
        const val MOTION_PHASE_SEED_WINDOW_MS = 60_000L
        const val TAG = "VoiceLevelView"
        val STAGE_BACKGROUND: Int = Color.rgb(3, 5, 10)

        fun softGlow(color: Int, alpha: Int): RadialGradient = RadialGradient(
            0f,
            0f,
            1f,
            intArrayOf(
                Color.argb(alpha, Color.red(color), Color.green(color), Color.blue(color)),
                Color.argb((alpha * 0.5f).toInt(), Color.red(color), Color.green(color), Color.blue(color)),
                Color.argb((alpha * 0.12f).toInt(), Color.red(color), Color.green(color), Color.blue(color)),
                Color.TRANSPARENT,
            ),
            floatArrayOf(0f, 0.34f, 0.72f, 1f),
            Shader.TileMode.CLAMP,
        )
    }
}
