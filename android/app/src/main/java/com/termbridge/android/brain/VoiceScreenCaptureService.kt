package com.termbridge.android.brain

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.Bitmap
import android.graphics.PixelFormat
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.Image
import android.media.ImageReader
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import android.view.WindowManager
import android.widget.Toast
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import com.termbridge.android.R
import java.io.ByteArrayOutputStream
import java.util.concurrent.Executors

/** One-shot, user-consented screen capture that becomes an opaque phone image attachment. */
class VoiceScreenCaptureService : Service() {
    private val handler = Handler(Looper.getMainLooper())
    private val worker = Executors.newSingleThreadExecutor { runnable ->
        Thread(runnable, "termbridge-screen-encode").apply { isDaemon = true }
    }
    private var projection: MediaProjection? = null
    private var display: VirtualDisplay? = null
    private var reader: ImageReader? = null
    private var completed = false
    private var actionId: String? = null
    private var attempts = 0
    private var readyAt = 0L

    private val projectionCallback = object : MediaProjection.Callback() {
        override fun onStop() {
            if (!completed) fail(IllegalStateException("screen capture permission ended"))
        }
    }

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (projection != null || completed) {
            PhoneScreenCaptureReceipt.finish(this, intent?.getStringExtra(PhoneScreenCaptureReceipt.EXTRA_ACTION_ID),
                error = "Another screen capture is in progress")
            return START_NOT_STICKY
        }
        actionId = intent?.getStringExtra(PhoneScreenCaptureReceipt.EXTRA_ACTION_ID)
        ServiceCompat.startForeground(
            this,
            NOTIFICATION_ID,
            NotificationCompat.Builder(this, CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_notification)
                .setContentTitle(getString(R.string.voice_screen_capture_notification_title))
                .setContentText(getString(R.string.voice_screen_capture_notification_detail))
                .setOngoing(true)
                .setSilent(true)
                .build(),
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION
            } else {
                0
            },
        )
        val resultCode = intent?.getIntExtra(EXTRA_RESULT_CODE, Int.MIN_VALUE) ?: Int.MIN_VALUE
        val resultData = intent?.projectionData()
        if (resultCode != android.app.Activity.RESULT_OK || resultData == null) {
            fail(IllegalArgumentException("screen capture permission is missing"))
            return START_NOT_STICKY
        }
        runCatching { beginCapture(resultCode, resultData) }.onFailure(::fail)
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        handler.removeCallbacksAndMessages(null)
        reader?.setOnImageAvailableListener(null, null)
        display?.release()
        reader?.close()
        projection?.unregisterCallback(projectionCallback)
        projection?.stop()
        worker.shutdownNow()
        VoiceCallOverlayService.showAfterCapture(this)
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun beginCapture(resultCode: Int, data: Intent) {
        val bounds = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            getSystemService(WindowManager::class.java).maximumWindowMetrics.bounds
        } else {
            @Suppress("DEPRECATION")
            android.graphics.Rect(0, 0, resources.displayMetrics.widthPixels, resources.displayMetrics.heightPixels)
        }
        val width = bounds.width().coerceAtLeast(1)
        val height = bounds.height().coerceAtLeast(1)
        val density = resources.displayMetrics.densityDpi
        val manager = getSystemService(MediaProjectionManager::class.java)
        projection = (manager.getMediaProjection(resultCode, data) ?: error("screen capture permission was rejected")).also {
            it.registerCallback(projectionCallback, handler)
        }
        reader = ImageReader.newInstance(width, height, PixelFormat.RGBA_8888, 2)
        display = projection!!.createVirtualDisplay(
            "TermBridge voice screen context",
            width,
            height,
            density,
            DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
            reader!!.surface,
            null,
            handler,
        )
        readyAt = SystemClock.elapsedRealtime() + CAPTURE_SETTLE_MS
        reader!!.setOnImageAvailableListener({ captureLatestFrame() }, handler)
        handler.postDelayed(::captureLatestFrame, CAPTURE_SETTLE_MS)
    }

    private fun captureLatestFrame() {
        if (completed) return
        if (!PhoneScreenCaptureReceipt.isPending(this, actionId)) {
            completed = true
            stopSelf()
            return
        }
        if (SystemClock.elapsedRealtime() < readyAt) return
        val image = runCatching { reader?.acquireLatestImage() }.getOrNull()
        if (image == null) {
            attempts += 1
            if (attempts >= MAX_ATTEMPTS) fail(IllegalStateException("screen did not produce a frame"))
            else handler.postDelayed(::captureLatestFrame, RETRY_MS)
            return
        }
        completed = true
        reader?.setOnImageAvailableListener(null, null)
        worker.execute {
            runCatching {
                val png = image.use(::encodePng)
                BrainImageAttachmentStore(this).importScreenCapture(png)
            }.onSuccess {
                if (!PhoneScreenCaptureReceipt.finish(this, actionId, attachment = it)) {
                    BrainImageAttachmentStore(this).discardCurrent()
                    return@onSuccess
                }
                BrainImageAttachmentStore(this).markUsed(it.actionId)
                Log.i(TAG, "screen frame attached actionId=${it.actionId} bytes=${it.assets.sumOf { asset -> asset.size }}")
                VoiceCallAttachmentEvents.publish(VoiceCallAttachmentEvent.Imported(it))
                handler.post {
                    Toast.makeText(this, R.string.voice_overlay_screen_attached, Toast.LENGTH_SHORT).show()
                }
            }.onFailure {
                PhoneScreenCaptureReceipt.finish(this, actionId, error = it.message)
                Log.w(TAG, "screen capture import failed", it)
                VoiceCallAttachmentEvents.publish(VoiceCallAttachmentEvent.Failed(
                    (it.message ?: it.javaClass.simpleName).take(300),
                ))
            }
            stopSelf()
        }
    }

    private fun encodePng(image: Image): ByteArray {
        val plane = image.planes.firstOrNull() ?: error("screen frame has no pixel plane")
        val pixelStride = plane.pixelStride
        val rowStride = plane.rowStride
        require(pixelStride > 0 && rowStride >= image.width * pixelStride) { "unsupported screen pixel layout" }
        val paddedWidth = rowStride / pixelStride
        val padded = Bitmap.createBitmap(paddedWidth, image.height, Bitmap.Config.ARGB_8888)
        return try {
            padded.copyPixelsFromBuffer(plane.buffer)
            val cropped = Bitmap.createBitmap(padded, 0, 0, image.width, image.height)
            try {
                ByteArrayOutputStream().use { output ->
                    check(cropped.compress(Bitmap.CompressFormat.PNG, 100, output)) { "could not encode screen capture" }
                    output.toByteArray()
                }
            } finally {
                if (cropped !== padded) cropped.recycle()
            }
        } finally {
            padded.recycle()
        }
    }

    private fun fail(error: Throwable) {
        if (completed) return
        completed = true
        PhoneScreenCaptureReceipt.finish(this, actionId, error = error.message)
        Log.w(TAG, "screen capture failed", error)
        VoiceCallAttachmentEvents.publish(VoiceCallAttachmentEvent.Failed(
            (error.message ?: error.javaClass.simpleName).take(300),
        ))
        stopSelf()
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        getSystemService(NotificationManager::class.java).createNotificationChannel(
            NotificationChannel(
                CHANNEL_ID,
                getString(R.string.voice_screen_capture_channel_name),
                NotificationManager.IMPORTANCE_LOW,
            ).apply { setSound(null, null) },
        )
    }

    @Suppress("DEPRECATION")
    private fun Intent.projectionData(): Intent? = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        getParcelableExtra(EXTRA_RESULT_DATA, Intent::class.java)
    } else {
        getParcelableExtra(EXTRA_RESULT_DATA)
    }

    companion object {
        private const val CHANNEL_ID = "voice_screen_capture"
        private const val TAG = "TermBridgeCapture"
        private const val NOTIFICATION_ID = 44
        private const val EXTRA_RESULT_CODE = "result_code"
        private const val EXTRA_RESULT_DATA = "result_data"
        private const val CAPTURE_SETTLE_MS = 550L
        private const val RETRY_MS = 100L
        private const val MAX_ATTEMPTS = 20

        fun capture(context: Context, resultCode: Int, data: Intent, actionId: String? = null) {
            ContextCompat.startForegroundService(
                context,
                Intent(context, VoiceScreenCaptureService::class.java)
                    .putExtra(EXTRA_RESULT_CODE, resultCode)
                    .putExtra(EXTRA_RESULT_DATA, data)
                    .putExtra(PhoneScreenCaptureReceipt.EXTRA_ACTION_ID, actionId),
            )
        }
    }
}
