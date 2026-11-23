package com.termbridge.android.brain

import android.content.Context
import com.termbridge.android.peer.AndroidPeerIdentity
import com.termbridge.android.peer.PhoneActionEvent
import com.termbridge.android.peer.PhoneActionNotifier
import com.termbridge.android.peer.PhoneActionOutbox
import com.termbridge.android.peer.PhoneActionResult
import com.termbridge.android.peer.PhoneActionStore

/** One-shot capture shares phone_action's durable, recoverable approval/result contract. */
object PhoneScreenCaptureReceipt {
    const val EXTRA_ACTION_ID = "screen_capture_action_id"

    fun isPending(context: Context, actionId: String?): Boolean {
        if (actionId == null) return true
        val store = PhoneActionStore(context)
        return store.load(actionId)?.action == "screen.capture" &&
            store.result(actionId)?.state !in setOf("cancelled", "denied", "completed", "failed", "expired")
    }

    fun finish(context: Context, actionId: String?, attachment: BrainImageAttachment? = null,
               state: String = "failed", error: String? = null): Boolean {
        if (actionId == null) return true // Explicit UI capture, not a tool invocation.
        val store = PhoneActionStore(context)
        val request = store.load(actionId) ?: return false
        if (!isPending(context, actionId)) return false
        val result = PhoneActionResult(actionId, request.action,
            if (attachment != null) "completed" else state,
            if (attachment != null) "已截取当前屏幕，等待查看图片" else "屏幕读取未完成",
            if (attachment != null) mapOf("imageAttachment" to attachment.toWireMap())
            else mapOf("error" to (error ?: "Screen capture was not authorized")))
        store.complete(result)
        PhoneActionOutbox.enqueue(context, PhoneActionEvent.create(request,
            AndroidPeerIdentity.deviceId(context), result.state, result.summary, result.data, error))
        PhoneActionNotifier.dismiss(context, actionId)
        return true
    }
}
