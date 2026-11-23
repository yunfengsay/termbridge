package com.termbridge.android

import android.os.Handler
import android.os.Looper
import androidx.lifecycle.ViewModel
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/**
 * The attachment queue for one session, held across configuration changes.
 *
 * Choosing an image takes the screen through a rotation or a recreate while an
 * upload is mid-encode, mid-flight or already acknowledged. Keeping this state
 * on the Activity meant every one of those stages lost the picture — the bytes
 * with the encoder thread, the Host path with the controller. It lives here
 * instead, retained by a ViewModel, and the screen attaches to it.
 *
 * Deliberately bounded and in memory only: at most six images of four MiB, no
 * Bundle (far too large), no disk cache. Nothing here holds an Activity, a View
 * or a Context, so a retained store cannot leak the screen that made it.
 */
class ComposerAttachmentStore(val key: String) {
    val uploads = TerminalImageUploads()

    /** Host paths already acknowledged, waiting to be named in a message. */
    val paths = mutableListOf<String>()

    /** Absolute deadlines, so a rotation re-arms the remaining time. */
    val deadlines = mutableMapOf<String, Long>()

    /** Survives the screen, so an encode in progress still completes. */
    val executor: ExecutorService = Executors.newSingleThreadExecutor()

    private val main = Handler(Looper.getMainLooper())

    /** Set by the attached controller, cleared when it detaches. */
    var onChanged: (() -> Unit)? = null

    /** Runs on the main thread whether or not a screen is attached right now. */
    fun post(block: () -> Unit) {
        main.post {
            block()
            onChanged?.invoke()
        }
    }

    fun close() {
        onChanged = null
        main.removeCallbacksAndMessages(null)
        executor.shutdownNow()
    }
}

/**
 * Keeps one store alive for as long as the screen exists.
 *
 * Keyed by Host profile and session: a screen that somehow ends up on another
 * conversation gets a fresh store rather than inheriting images meant for a
 * different Agent.
 */
class ComposerAttachmentsViewModel : ViewModel() {
    private var store: ComposerAttachmentStore? = null

    fun storeFor(key: String): ComposerAttachmentStore {
        val existing = store
        if (existing != null && existing.key == key) return existing
        existing?.close()
        return ComposerAttachmentStore(key).also { store = it }
    }

    override fun onCleared() {
        store?.close()
        store = null
    }
}
