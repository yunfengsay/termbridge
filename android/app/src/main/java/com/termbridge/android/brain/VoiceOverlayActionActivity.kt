package com.termbridge.android.brain

import android.app.Activity.RESULT_OK
import android.content.Context
import android.content.Intent
import android.media.projection.MediaProjectionManager
import android.os.Bundle
import android.util.Log
import android.widget.Toast
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import com.termbridge.android.R
import com.termbridge.android.peer.PhoneActionRequest
import java.util.concurrent.Executors

/** Small, transient system-picker/MediaProjection owner launched from the floating call controls. */
class VoiceOverlayActionActivity : AppCompatActivity() {
    private val worker = Executors.newSingleThreadExecutor { runnable ->
        Thread(runnable, "termbridge-floating-attachment").apply { isDaemon = true }
    }
    private var launched = false

    private val imagePicker = registerForActivityResult(
        ActivityResultContracts.PickMultipleVisualMedia(PhoneActionRequest.MAX_PHOTO_SELECTION),
    ) { uris ->
        if (uris.isEmpty()) {
            finish()
            return@registerForActivityResult
        }
        worker.execute {
            runCatching { BrainImageAttachmentStore(this).import(uris) }
                .onSuccess {
                    Log.i(TAG, "floating images attached actionId=${it.actionId} count=${it.assets.size}")
                    VoiceCallAttachmentEvents.publish(VoiceCallAttachmentEvent.Imported(it))
                    runOnUiThread {
                        Toast.makeText(
                            this,
                            getString(R.string.voice_overlay_images_attached, it.assets.size),
                            Toast.LENGTH_SHORT,
                        ).show()
                    }
                }
                .onFailure { publishFailure(it) }
            runOnUiThread { finish() }
        }
    }

    private val screenCapturePermission = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult(),
    ) { result ->
        val data = result.data
        if (!PhoneScreenCaptureReceipt.isPending(this, intent.getStringExtra(PhoneScreenCaptureReceipt.EXTRA_ACTION_ID))) {
            VoiceCallOverlayService.showAfterCapture(this)
            finish()
            return@registerForActivityResult
        }
        if (result.resultCode == RESULT_OK && data != null) {
            runCatching {
                VoiceScreenCaptureService.capture(this, result.resultCode, data,
                    intent.getStringExtra(PhoneScreenCaptureReceipt.EXTRA_ACTION_ID))
            }.onFailure {
                PhoneScreenCaptureReceipt.finish(this, intent.getStringExtra(PhoneScreenCaptureReceipt.EXTRA_ACTION_ID),
                    error = it.message)
                VoiceCallOverlayService.showAfterCapture(this)
            }
        } else {
            PhoneScreenCaptureReceipt.finish(this, intent.getStringExtra(PhoneScreenCaptureReceipt.EXTRA_ACTION_ID),
                state = "denied")
            VoiceCallOverlayService.showAfterCapture(this)
        }
        finish()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (savedInstanceState == null) launchRequestedAction()
    }

    override fun onDestroy() {
        worker.shutdownNow()
        super.onDestroy()
    }

    private fun launchRequestedAction() {
        if (launched) return
        launched = true
        when (intent.action) {
            ACTION_PICK_IMAGES -> imagePicker.launch(
                PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly),
            )
            ACTION_CAPTURE_SCREEN -> {
                VoiceCallOverlayService.hideForCapture(this)
                val manager = getSystemService(MediaProjectionManager::class.java)
                runCatching { screenCapturePermission.launch(manager.createScreenCaptureIntent()) }
                    .onFailure {
                        PhoneScreenCaptureReceipt.finish(this, intent.getStringExtra(PhoneScreenCaptureReceipt.EXTRA_ACTION_ID),
                            error = it.message)
                        VoiceCallOverlayService.showAfterCapture(this)
                        finish()
                    }
            }
            else -> finish()
        }
    }

    private fun publishFailure(error: Throwable) {
        val message = (error.message ?: error.javaClass.simpleName).take(300)
        VoiceCallAttachmentEvents.publish(VoiceCallAttachmentEvent.Failed(message))
        runOnUiThread {
            Toast.makeText(this, getString(R.string.voice_overlay_attachment_failed, message), Toast.LENGTH_LONG).show()
        }
    }

    companion object {
        private const val ACTION_PICK_IMAGES = "com.termbridge.android.action.FLOATING_PICK_IMAGES"
        private const val ACTION_CAPTURE_SCREEN = "com.termbridge.android.action.FLOATING_CAPTURE_SCREEN"
        private const val TAG = "TermBridgeOverlay"

        fun pickImagesIntent(context: Context): Intent = Intent(context, VoiceOverlayActionActivity::class.java)
            .setAction(ACTION_PICK_IMAGES)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)

        fun captureScreenIntent(context: Context): Intent = Intent(context, VoiceOverlayActionActivity::class.java)
            .setAction(ACTION_CAPTURE_SCREEN)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    }
}
