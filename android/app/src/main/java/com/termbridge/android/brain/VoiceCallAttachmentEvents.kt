package com.termbridge.android.brain

import java.util.concurrent.CopyOnWriteArraySet

/** Process-local handoff from floating capture/picker UI to the active Voice Call transport. */
sealed interface VoiceCallAttachmentEvent {
    data class Imported(val attachment: BrainImageAttachment) : VoiceCallAttachmentEvent
    data class Failed(val message: String) : VoiceCallAttachmentEvent
}

object VoiceCallAttachmentEvents {
    private val listeners = CopyOnWriteArraySet<(VoiceCallAttachmentEvent) -> Unit>()

    fun addListener(listener: (VoiceCallAttachmentEvent) -> Unit) {
        listeners += listener
    }

    fun removeListener(listener: (VoiceCallAttachmentEvent) -> Unit) {
        listeners -= listener
    }

    fun publish(event: VoiceCallAttachmentEvent) {
        listeners.forEach { it(event) }
    }
}
