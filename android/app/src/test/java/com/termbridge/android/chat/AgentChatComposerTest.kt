package com.termbridge.android.chat

import com.termbridge.android.ComposerPayload
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The chat composer sends the same thing the terminal composer sends: the typed
 * draft with each uploaded image named by its Host path. These cover what the
 * views cannot — that the draft the receipt machinery tracks is that combined
 * text, so a retry resends the images too.
 */
class AgentChatComposerTest {
    private fun attachmentsEnabled(capabilities: Map<String, Any?>) = capabilities["attachments"] == true

    @Test
    fun theSubmittedMessageCarriesTheUploadedPathsSoARetryResendsThem() {
        val draft = AgentChatDraft()
        draft.text = "看看这张图"
        // What the Activity does: the payload, not the raw draft, is submitted.
        draft.text = ComposerPayload.build(draft.text, listOf("/Users/x/.termbridge/uploads/a.jpg"))
        val sent = draft.begin("r1", 3)
        assertEquals("看看这张图 [Image: /Users/x/.termbridge/uploads/a.jpg]", sent)

        draft.receipt("r1", 3, "failed", "not sent")
        assertTrue(draft.retryable)
        // The restored text still names the image; retrying cannot drop it.
        assertEquals(sent, draft.text)
        assertEquals(sent, draft.submittedText())
    }

    @Test
    fun anImageOnlyMessageIsSendable() {
        val draft = AgentChatDraft()
        val payload = ComposerPayload.build(draft.text, listOf("/tmp/shot.png"))
        assertEquals("[Image: /tmp/shot.png]", payload)
        draft.text = payload
        assertEquals(payload, draft.begin("r2", 1))
    }

    @Test
    fun anUncertainSendIsNeverResentByItself() {
        val draft = AgentChatDraft()
        draft.text = ComposerPayload.build("重试一下", listOf("/tmp/a.png"))
        val sent = draft.begin("r3", 1)
        draft.disconnected("结果未知")
        assertEquals("uncertain", draft.state)
        // Not retryable and not put back in the box: the user decides after
        // checking the terminal, and the text stays available to copy.
        assertFalse(draft.retryable)
        assertEquals("", draft.text)
        assertEquals(sent, draft.submittedText())
    }

    @Test
    fun aHostThatDoesNotReportAttachmentsKeepsThemOff() {
        assertFalse(attachmentsEnabled(emptyMap()))
        assertFalse(attachmentsEnabled(mapOf("send" to true)))
        assertFalse(attachmentsEnabled(mapOf("attachments" to false)))
        // Only an explicit true from this Host turns the control on.
        assertTrue(attachmentsEnabled(mapOf("attachments" to true)))
    }
}
