package com.termbridge.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The four stages a picked image can be in when the screen is recreated.
 * Each one used to lose the picture; none of them may now.
 */
class TerminalImageUploadsRetainedTest {
    private val image = EncodedImage("image/jpeg", byteArrayOf(1, 2, 3))

    @Test
    fun anImageStillEncodingSurvivesAndUploadsAfterwards() {
        val queue = TerminalImageUploads()
        val id = queue.add("s1")
        // Rotation happens here: the queue lives in the retained store, so the
        // entry is still waiting for its bytes.
        assertEquals(1, queue.size)
        queue.encoded(id, image)
        assertEquals(listOf(id), queue.takeReady("s1").map { it.id })
    }

    @Test
    fun anImageWaitingForAuthorizationIsNotSentAndIsNotLost() {
        val queue = TerminalImageUploads()
        val id = queue.add("s1")
        queue.encoded(id, image)
        // Addressed to a session that is not the one currently authorized.
        assertTrue(queue.takeReady("other").isEmpty())
        assertEquals(1, queue.size)
        assertEquals(listOf(id), queue.takeReady("s1").map { it.id })
    }

    @Test
    fun anImageSentButUnacknowledgedIsKeptAsUnknownAndNeverResent() {
        val queue = TerminalImageUploads()
        val id = queue.add("s1")
        queue.encoded(id, image)
        queue.takeReady("s1")

        // The connection goes away before the result arrives.
        assertEquals(listOf(id), queue.interrupted())
        // Kept, because the file may well be on the Host: not deleted.
        assertEquals(1, queue.unknownCount)
        // It no longer blocks the composer, and it is never offered for resend.
        assertEquals(0, queue.size)
        assertTrue(queue.takeReady("s1").isEmpty())
        // A late acknowledgement for it is refused rather than applied.
        assertFalse(queue.acknowledge(id, "s1"))
        // The user can clear it explicitly.
        queue.clearUnknown()
        assertEquals(0, queue.unknownCount)
    }

    /**
     * The gate the composer actually consults.
     *
     * `isIdle` is `pending.isEmpty()`, and the send button, the IME send path
     * and the control that clears attachments all hang off it. When an upload
     * whose result can never arrive counted as "in progress", every one of them
     * refused at once and there was no way back to typing.
     */
    @Test
    fun anUnknownUploadDoesNotWedgeTheComposer() {
        val queue = TerminalImageUploads()
        val id = queue.add("s1")
        queue.encoded(id, image)
        queue.takeReady("s1")

        // While it is genuinely in flight, submitting is blocked — as it should
        // be, or the text would go without the image it refers to.
        assertFalse(queue.isEmpty())

        queue.interrupted()
        // Now it is held, not in flight: the composer is usable again.
        assertTrue(queue.isEmpty())
        assertFalse(queue.isNotEmpty())
        // And it is still there, visible and waiting to be dealt with.
        assertTrue(queue.hasUnknown())
        assertEquals(1, queue.unknownCount)

        // Clearing is what the user's tap does, and it is not blocked either.
        queue.clearUnknown()
        assertFalse(queue.hasUnknown())
        assertTrue(queue.isEmpty())
    }

    @Test
    fun aFreshUploadStillBlocksWhileAnUnknownOneIsHeld() {
        val queue = TerminalImageUploads()
        val stale = queue.add("s1")
        queue.encoded(stale, image)
        queue.takeReady("s1")
        queue.interrupted()

        // A new pick after the connection came back is a real upload again, so
        // it blocks submission until it resolves — the held one does not.
        val fresh = queue.add("s1")
        assertFalse(queue.isEmpty())
        queue.encoded(fresh, image)
        assertEquals(listOf(fresh), queue.takeReady("s1").map { it.id })
        assertTrue(queue.acknowledge(fresh, "s1"))
        assertTrue(queue.isEmpty())
        assertTrue(queue.hasUnknown())
    }

    /**
     * The limit is about memory, not about progress. A held upload still owns
     * its encoded bytes, so it counts — otherwise a connection that keeps
     * dropping accumulates images six at a time with no bound at all.
     */
    @Test
    fun heldUploadsCountTowardsTheQueueLimit() {
        val queue = TerminalImageUploads()
        repeat(6) { index ->
            val id = queue.add("s1")
            queue.encoded(id, image)
            assertEquals(index + 1, queue.retainedCount)
        }
        queue.takeReady("s1")
        queue.interrupted()

        // All six are now unknown: none is active, but all six are still held.
        assertEquals(0, queue.size)
        assertTrue(queue.isEmpty())
        assertEquals(6, queue.unknownCount)
        assertEquals(6, queue.retainedCount)

        // A seventh must not be accepted while they are still there.
        assertEquals(6, queue.retainedCount)

        // Clearing them frees the room again.
        queue.clearUnknown()
        assertEquals(0, queue.retainedCount)
    }

    @Test
    fun anAcknowledgedUploadIsSettledAndCountsForNothingFurther() {
        val queue = TerminalImageUploads()
        val id = queue.add("s1")
        queue.encoded(id, image)
        queue.takeReady("s1")
        assertTrue(queue.acknowledge(id, "s1"))
        assertEquals(0, queue.size)
        // Its Host path is what the composer keeps; the entry is done.
        assertFalse(queue.acknowledge(id, "s1"))
    }
}
