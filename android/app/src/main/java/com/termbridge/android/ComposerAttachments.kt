package com.termbridge.android

import android.content.Context
import android.net.Uri
import android.os.Handler
import android.widget.EditText
import android.widget.ImageButton
import android.widget.TextView
import android.widget.Toast
import androidx.core.view.ContentInfoCompat
import androidx.core.view.ViewCompat
import androidx.core.view.isVisible

/**
 * The attachment half of the composer, shared by the terminal and chat views.
 *
 * Both views write into the same pane, so an image has to reach the Agent the
 * same way from either one: the bytes go to the Host, and the Host path it
 * returns is named in the message text. Holding that in one place is what makes
 * the two composers the same composer instead of two that merely resemble each
 * other.
 *
 * The owner supplies when uploading is allowed and how a control frame is sent,
 * because the two views earn that right differently — the terminal by attaching
 * a session, the chat view by holding a subscription to it.
 */
class ComposerAttachments(
    private val context: Context,
    private val handler: Handler,
    private val store: ComposerAttachmentStore,
    private val status: TextView,
    private val attach: ImageButton,
    private val input: EditText,
    private val owner: Owner,
) {
    interface Owner {
        /**
         * The session an attachment belongs to, or null when this screen has
         * none. Known from the screen's own identity, not from the connection:
         * a picker result that arrives while reconnecting is still this
         * session's image and is held until it can go out.
         */
        fun attachmentSessionId(): String?

        /** Whether a queued upload can actually leave right now. */
        fun uploadReady(): Boolean

        /** @return false when the frame could not be handed to the socket. */
        fun sendUpload(requestId: String, sessionId: String, image: EncodedImage): Boolean

        /** The owner re-evaluates its own send button; attachments alone can enable it. */
        fun onAttachmentsChanged()

        /** Whether this Host offers attachments at all. */
        fun attachmentsAllowed(): Boolean = true

        /** Why a refused attachment was refused, so the reason is never implied. */
        fun notReadyMessage(): Int = R.string.terminal_not_ready
    }

    private val pending get() = store.uploads
    private val paths get() = store.paths
    private val timeouts = mutableMapOf<String, Runnable>()

    /** Host paths already acknowledged, ready to be named in the next message. */
    val readyCount: Int get() = paths.size
    val uploadingCount: Int get() = pending.size
    /**
     * Nothing is still in flight, so a message may go.
     *
     * Deliberately true while unknown uploads are held: their result will never
     * arrive, and blocking the composer on them leaves the user unable to type
     * at all. They are reported, and clearing them is a separate action.
     */
    val isIdle: Boolean get() = pending.isEmpty()

    /** Kept uploads whose outcome was never learned. */
    val unknownCount: Int get() = pending.unknownCount

    /** Picker and paste both land here; [launchPicker] is the owner's control. */
    fun bind(launchPicker: () -> Unit) {
        // Adopt whatever the retained store already holds: acknowledged paths,
        // uploads still encoding, and uploads awaiting a result. Their timers
        // are re-armed for the time they have left rather than restarted.
        // The live controller is what sends: a completion that arrived while no
        // screen was bound goes out as soon as one is.
        store.onChanged = { flush() }
        val now = System.currentTimeMillis()
        for ((requestId, deadline) in store.deadlines.toList()) {
            if (pending.isEmpty()) break
            val remaining = deadline - now
            if (remaining <= 0) { fail(requestId, context.getString(R.string.image_upload_timeout)); continue }
            val timeout = Runnable { fail(requestId, context.getString(R.string.image_upload_timeout)) }
            timeouts[requestId] = timeout
            handler.postDelayed(timeout, remaining)
        }
        attach.isFocusable = false
        attach.setOnClickListener { launchPicker() }
        status.setOnClickListener {
            // Nothing is dropped while uploads are still in flight — those are
            // the ones still arriving. Otherwise the tap deals with whatever is
            // actually in front of the user: the unresolved ones first, since
            // those are the ones asking to be dealt with, and only then the
            // attachments they have ready to send.
            if (!isIdle) return@setOnClickListener
            if (pending.hasUnknown()) pending.clearUnknown() else paths.clear()
            render()
        }
        ViewCompat.setOnReceiveContentListener(input, arrayOf("image/*")) { _, payload ->
            val split = payload.partition { item -> item.uri != null }
            split.first?.let { imageContent ->
                val clip = imageContent.clip
                for (index in 0 until clip.itemCount) {
                    clip.getItemAt(index).uri?.let { uri -> queue(uri, imageContent) }
                }
            }
            split.second
        }
    }

    fun queue(uri: Uri, permissionLease: ContentInfoCompat? = null) {
        // Deliberately not gated on the connection being up. Dropping a picked
        // image because the socket is still reconnecting loses the user's file
        // with nothing to show for it; it waits in the queue instead.
        val target = owner.attachmentSessionId()
        if (target == null || !owner.attachmentsAllowed()) {
            Toast.makeText(context, owner.notReadyMessage(), Toast.LENGTH_SHORT).show()
            return
        }
        // Counts held uploads too: their bytes are still in memory, so they are
        // part of what the limit exists to bound.
        if (pending.retainedCount >= MAX_QUEUED) {
            Toast.makeText(context, R.string.image_upload_queue_full, Toast.LENGTH_SHORT).show()
            return
        }
        val requestId = pending.add(target)
        val timeout = Runnable { fail(requestId, context.getString(R.string.image_upload_timeout)) }
        timeouts[requestId] = timeout
        store.deadlines[requestId] = System.currentTimeMillis() + UPLOAD_TIMEOUT_MS
        handler.postDelayed(timeout, UPLOAD_TIMEOUT_MS)
        render()
        // The encoder and its completion belong to the retained store, so a
        // rotation mid-encode still ends with the image in the queue.
        val appContext = context.applicationContext
        // Locals, not fields.
        //
        // `store` is a constructor property, so naming it inside the lambda
        // compiles to a read through `this` — which captures this controller,
        // and with it the Activity and its views. Copying what the work needs
        // into locals first is what actually keeps the encode independent of the
        // screen that started it; a comment saying "only the store" does not.
        // Completion writes to the store alone; whichever controller is bound
        // then flushes through `onChanged`.
        val retained = store
        retained.executor.execute {
            @Suppress("UNUSED_VARIABLE")
            val keepUriPermissionUntilComplete = permissionLease
            // A plain try/catch, not `runCatching`: that one is the extension
            // `T.runCatching`, so writing it bare inside a member binds `this`
            // as its receiver and the lambda captures this controller again.
            val encoded: EncodedImage? = try {
                NativeImageEncoder.encode(appContext.contentResolver, uri)
            } catch (error: Throwable) {
                null
            }
            retained.post {
                if (encoded != null) retained.uploads.encoded(requestId, encoded)
                else { retained.uploads.remove(requestId); retained.deadlines.remove(requestId) }
            }
        }
    }

    /** Sends everything encoded and addressed to this session, once it can go. */
    fun flush() {
        val target = owner.attachmentSessionId()
        if (target == null || !owner.uploadReady()) {
            render()
            return
        }
        pending.takeReady(target).forEach { upload ->
            val image = upload.image ?: return@forEach
            if (!owner.sendUpload(upload.id, upload.sessionId, image)) {
                fail(upload.id, context.getString(R.string.terminal_not_ready))
            }
        }
        render()
    }

    /**
     * @return true when the result belonged to this queue, so the caller knows
     * whether the frame was consumed here.
     */
    fun acknowledge(requestId: String, sessionId: String, path: String?, error: String?): Boolean {
        if (!pending.acknowledge(requestId, sessionId)) return false
        store.deadlines.remove(requestId)
        timeouts.remove(requestId)?.let(handler::removeCallbacks)
        if (!path.isNullOrBlank()) paths += path
        if (!error.isNullOrBlank()) {
            Toast.makeText(context, context.getString(R.string.image_upload_failed, error), Toast.LENGTH_LONG).show()
        }
        render()
        input.requestFocus()
        return true
    }

    private fun fail(requestId: String, error: String) {
        if (!pending.remove(requestId)) return
        store.deadlines.remove(requestId)
        timeouts.remove(requestId)?.let(handler::removeCallbacks)
        render()
        Toast.makeText(context, context.getString(R.string.image_upload_failed, error), Toast.LENGTH_LONG).show()
    }

    /**
     * A connection went away with uploads already sent.
     *
     * Their outcome is unknowable, so they are marked rather than dropped: the
     * bytes may well have reached the Host, and deleting the entry would lose
     * the user's picture with nothing to show for it. None of them is resent.
     * Unsent picker results stay queued for the next time uploading is allowed.
     */
    fun interrupt() {
        val interrupted = pending.interrupted()
        interrupted.forEach { requestId ->
            store.deadlines.remove(requestId)
            timeouts.remove(requestId)?.let(handler::removeCallbacks)
        }
        if (interrupted.isNotEmpty()) render()
    }

    /** How many uploads are still unresolved; their result is not yet known. */
    fun inFlightCount(): Int = pending.size

    /**
     * Detaches this screen from the retained queue without discarding it.
     *
     * A rotation destroys the Activity, not the upload: the store keeps the
     * bytes, the paths and the deadlines, and the next controller re-arms them.
     * Only the ViewModel being cleared — the screen genuinely finishing — ends
     * the queue.
     */
    fun dispose() {
        if (store.onChanged != null) store.onChanged = null
        timeouts.values.forEach(handler::removeCallbacks)
        timeouts.clear()
    }

    /** The terminal's message: one line, plus each acknowledged path. */
    fun payload(draft: String): String = ComposerPayload.build(draft, paths)

    /** The chat view's message: the draft byte for byte, plus each path. */
    fun verbatimPayload(draft: String): String = ComposerPayload.buildVerbatim(draft, paths)

    /** Called once a message carrying these paths has really been handed over. */
    fun consumed() {
        paths.clear()
        render()
    }

    fun render() {
        val uploading = pending.size
        val unknown = pending.unknownCount
        val ready = paths.size
        val offered = owner.attachmentsAllowed() && owner.attachmentSessionId() != null
        val sendable = offered && owner.uploadReady()
        status.isVisible = uploading > 0 || ready > 0 || unknown > 0
        status.text = when {
            // Held, not lost: says so instead of looking stuck.
            uploading > 0 && !sendable -> context.getString(R.string.composer_upload_waiting, uploading)
            uploading > 0 -> context.getString(R.string.composer_uploading, uploading)
            // Neither claimed nor discarded, and never resent.
            unknown > 0 -> context.getString(R.string.composer_upload_unknown, unknown)
            ready > 0 -> context.getString(R.string.composer_attachments, ready)
            else -> ""
        }
        attach.isEnabled = sendable && uploading == 0
        owner.onAttachmentsChanged()
    }

    private companion object {
        const val MAX_QUEUED = 6
        const val UPLOAD_TIMEOUT_MS = 45_000L
    }
}
