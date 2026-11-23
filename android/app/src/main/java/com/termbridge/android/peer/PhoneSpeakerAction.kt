package com.termbridge.android.peer

import android.content.Context
import com.termbridge.android.brain.VoiceCallSpeakerController

object PhoneSpeakerAction {
    fun execute(context: Context, request: PhoneActionRequest): PhoneActionResult {
        val enabled = requireNotNull(request.enabled) { "missing enabled" }
        val route = VoiceCallSpeakerController.set(context, enabled)
        check(route.applied) { "当前设备无法切换通话音频路由" }
        return PhoneActionResult(
            request.actionId,
            request.action,
            "completed",
            if (route.enabled) "已打开外放" else "已关闭外放",
            mapOf("enabled" to route.enabled, "callActive" to route.callActive),
        )
    }
}
