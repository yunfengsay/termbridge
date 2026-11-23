package com.termbridge.android.brain

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.termbridge.android.protocol.ControlMessage
import com.termbridge.android.watch.ZeppGlobalVoiceController
import com.termbridge.android.watch.ZeppVoiceDecision
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CopyOnWriteArrayList

/** Replays the observed watch reply path without a microphone, cloud call, or real audio. */
@RunWith(AndroidJUnit4::class)
class WatchReplyPrivacyTest {
    @Test fun watchReplyNeverStartsHiddenPhoneSynthesisOrPlayback() {
        val sent = CopyOnWriteArrayList<Map<String, Any?>>()
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        ZeppGlobalVoiceController(context, { true }, { sent += it.toMap(); true },
            decoder = { _, _ -> ByteArray(3200) }).use { controller ->
            val turn = controller.submit(ByteArray(64))
            val deadline = System.currentTimeMillis() + 5000
            while (sent.none { it["t"] == "brain_transcribe_commit" } && System.currentTimeMillis() < deadline) Thread.sleep(20)
            val asrId = sent.first { it["t"] == "brain_transcribe_start" }["requestId"] as String
            controller.handle(ControlMessage("brain_transcribe_result", mapOf("requestId" to asrId, "text" to "合成测试", "final" to true)))
            if (controller.snapshot(turn.id)?.state == ZeppGlobalVoiceController.STATE_AWAITING_CONFIRMATION) {
                controller.decide(turn.id, ZeppVoiceDecision.CONFIRM)
            }
            val requestId = sent.first { it["t"] == "brain_send" }["requestId"] as String
            controller.handle(ControlMessage("brain_snapshot_result", mapOf("messages" to listOf(mapOf(
                "id" to "$requestId-brain", "role" to "brain", "text" to "仅文字结果", "createdAt" to 1L,
            )))))
            assertEquals("done", controller.snapshot(turn.id)?.state)
            assertEquals("仅文字结果", controller.snapshot(turn.id)?.reply)
            assertFalse(sent.any { it["t"] == "brain_synthesize" })
            // A delayed result from an earlier app version must not re-open playback.
            controller.handle(ControlMessage("brain_synthesize_result", mapOf("requestId" to "${turn.id}-tts", "data" to byteArrayOf(1, 2))))
            assertEquals("done", controller.snapshot(turn.id)?.state)
            assertFalse(VoiceCallUiState.current().active)
        }
    }
}
