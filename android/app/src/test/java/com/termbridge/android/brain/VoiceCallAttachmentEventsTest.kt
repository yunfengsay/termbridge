package com.termbridge.android.brain

import com.termbridge.android.peer.PhoneSelectedAsset
import org.junit.Assert.assertEquals
import org.junit.Test

class VoiceCallAttachmentEventsTest {
    @Test
    fun `floating capture reaches only active call listeners`() {
        val received = mutableListOf<VoiceCallAttachmentEvent>()
        val listener: (VoiceCallAttachmentEvent) -> Unit = received::add
        val attachment = BrainImageAttachment(
            actionId = "brain-image-capture",
            deviceId = "android-device-1234",
            assets = listOf(PhoneSelectedAsset("asset-1", "screen.png", "image/png", 42, "a".repeat(64))),
        )

        VoiceCallAttachmentEvents.addListener(listener)
        VoiceCallAttachmentEvents.publish(VoiceCallAttachmentEvent.Imported(attachment))
        VoiceCallAttachmentEvents.removeListener(listener)
        VoiceCallAttachmentEvents.publish(VoiceCallAttachmentEvent.Failed("ignored"))

        assertEquals(listOf(VoiceCallAttachmentEvent.Imported(attachment)), received)
    }
}
